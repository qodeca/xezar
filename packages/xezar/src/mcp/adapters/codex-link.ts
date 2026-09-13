import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import WebSocket from 'ws';

import type { CodexAppServerMessage } from '../../core/codex-app-server-transport.ts';
import type { CodexAppServerLink } from './codex.ts';

/** The only control socket layout measured for a shared Codex app-server. */
export const CODEX_CONTROL_SOCKET = join('app-server-control', 'app-server-control.sock');
const TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 1_000_000;

export interface CodexLeaderAnnouncement {
  readonly codexHome: string;
  readonly threadId: string;
}

export interface ConnectedCodexLeader {
  readonly link: CodexAppServerLink & { close(): void };
  readonly threadId: string;
}

/**
 * Connect to an already-running shared app-server. This starts no process and accepts no socket
 * path from the cockpit: the bridge-provided CODEX_HOME fixes the sole candidate.
 */
export async function connectCodexLeader(announcement: CodexLeaderAnnouncement, projectRoot: string): Promise<ConnectedCodexLeader> {
  const home = realpathSync(announcement.codexHome);
  const expectedProject = realpathSync(projectRoot);
  const socketPath = join(home, CODEX_CONTROL_SOCKET);
  validateControlSocket(socketPath);
  const link = await CodexWsLink.connect(socketPath);
  try {
    const initialized = await link.request('initialize', { clientInfo: { name: 'xezar', version: 'local' } });
    if (typeof initialized.codexHome !== 'string' || realpathSync(initialized.codexHome) !== home) throw new Error('the Codex app-server did not confirm its announced CODEX_HOME');
    const listed = await link.request('thread/list', { cwd: expectedProject, modelProviders: [] });
    const loaded = await link.request('thread/loaded/list', {});
    const candidates = threads(listed).filter((thread) => thread.id === announcement.threadId && thread.cwd === expectedProject);
    // codex-cli 0.154.0's ThreadLoadedListResponse.data is string[], unlike thread/list.
    // Keeping this separate is important: treating loaded ids as thread records silently makes
    // every valid attachment look unloaded.
    const loadedIds = new Set(loadedIdsFrom(loaded));
    if (candidates.length !== 1 || !loadedIds.has(announcement.threadId)) throw new Error('the announced Codex thread is absent, stale, ambiguous, or not loaded for this project');
    const resumed = await link.request('thread/resume', { threadId: announcement.threadId, excludeTurns: true });
    if (threadIdFrom(resumed) !== announcement.threadId) throw new Error('the Codex app-server resumed a different thread');
    return { link, threadId: announcement.threadId };
  } catch (error) {
    link.close();
    throw error;
  }
}

function threads(value: Record<string, unknown>): Array<{ id: string; cwd?: string }> {
  const data = Array.isArray(value.data) ? value.data : Array.isArray(value.threads) ? value.threads : [];
  return data.flatMap((value) => {
    if (typeof value !== 'object' || value === null) return [];
    const item = value as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : typeof (item.thread as Record<string, unknown> | undefined)?.id === 'string' ? (item.thread as Record<string, unknown>).id as string : undefined;
    const cwd = typeof item.cwd === 'string' ? item.cwd : typeof (item.thread as Record<string, unknown> | undefined)?.cwd === 'string' ? (item.thread as Record<string, unknown>).cwd as string : undefined;
    return id === undefined ? [] : [{ id, ...(cwd === undefined ? {} : { cwd }) }];
  });
}

function loadedIdsFrom(value: Record<string, unknown>): string[] {
  const data = Array.isArray(value.data) ? value.data : [];
  return data.filter((id): id is string => typeof id === 'string');
}

function threadIdFrom(value: Record<string, unknown>): string | undefined {
  if (typeof value.threadId === 'string') return value.threadId;
  const thread = value.thread as Record<string, unknown> | undefined;
  return typeof thread?.id === 'string' ? thread.id : undefined;
}

/** Local socket, current user, and a private parent: no world-writable rendezvous point. */
export function validateControlSocket(socketPath: string): void {
  const socket = lstatSync(socketPath);
  const parent = statSync(dirname(socketPath));
  if (!socket.isSocket()) throw new Error('the Codex control endpoint is not a Unix socket');
  if (socket.uid !== process.getuid?.()) throw new Error('the Codex control socket belongs to another user');
  if (parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) throw new Error('the Codex control socket parent is not private to this user');
}

class CodexWsLink implements CodexAppServerLink {
  #closed = false;
  #nextId = 1;
  readonly #listeners = new Set<(message: CodexAppServerMessage) => void>();
  readonly #pending = new Map<number, { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  readonly #socket: WebSocket;
  private constructor(socket: WebSocket) {
    this.#socket = socket;
    this.#socket.on('message', (data) => this.#receive(data));
    this.#socket.on('close', () => this.#shutdown(new Error('the Codex app-server closed xezar’s link')));
    this.#socket.on('error', (error) => this.#shutdown(error));
    this.#socket.on('ping', (data) => this.#socket.pong(data));
  }

  static connect(socketPath: string): Promise<CodexWsLink> {
    return new Promise((resolve, reject) => {
      // ws+unix is ws's documented Unix-socket Upgrade transport; `socketPath` alone is ignored
      // for ordinary ws:// URLs and would silently dial localhost instead.
      const socket = new WebSocket(`ws+unix://${socketPath}:/`, { maxPayload: MAX_FRAME_BYTES, handshakeTimeout: TIMEOUT_MS });
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('timed out connecting to the Codex app-server')); }, TIMEOUT_MS);
      socket.once('open', () => { clearTimeout(timer); resolve(new CodexWsLink(socket)); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
  }

  get closed(): boolean { return this.#closed || this.#socket.readyState !== WebSocket.OPEN; }
  subscribe(listener: (message: CodexAppServerMessage) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  close(): void { this.#shutdown(new Error('xezar detached from the Codex app-server')); }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('the Codex app-server connection is closed'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`Codex app-server ${method} timed out`)); }, TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), (error) => { if (error) this.#shutdown(error); });
    });
  }

  #receive(raw: WebSocket.RawData): void {
    if (Buffer.byteLength(raw.toString()) > MAX_FRAME_BYTES) return this.#shutdown(new Error('the Codex app-server sent an oversized frame'));
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return this.#shutdown(new Error('the Codex app-server sent invalid JSON')); }
    if (typeof message.id === 'number' && this.#pending.has(message.id)) {
      const pending = this.#pending.get(message.id)!; this.#pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error !== undefined) pending.reject(new Error(typeof (message.error as Record<string, unknown>).message === 'string' ? (message.error as Record<string, unknown>).message as string : 'Codex app-server refused the request'));
      else pending.resolve((message.result ?? {}) as Record<string, unknown>);
      return;
    }
    for (const listener of this.#listeners) listener(message as CodexAppServerMessage);
  }

  #shutdown(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear(); this.#listeners.clear(); this.#socket.terminate();
  }
}
