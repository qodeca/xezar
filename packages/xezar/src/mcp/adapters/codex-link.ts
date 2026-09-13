import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';

import type { CodexAppServerMessage } from '../../core/codex-app-server-transport.ts';
import { agentHomePaths } from '../../paths.ts';
import { type CodexAppServerLink, codexLoadedIds, CodexRequestRefused, type CodexThreadState, codexThreadState, type CodexUnreachableReason } from './codex.ts';

/** The only control socket layout measured for a shared Codex app-server. */
export const CODEX_CONTROL_SOCKET = join('app-server-control', 'app-server-control.sock');
const TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 1_000_000;
/** `thread/list` is paged; a project with more sessions than this reads as "not found", never as a guess. */
const MAX_LIST_PAGES = 20;

/**
 * What the owning Codex bridge announces: the upstream thread its tool calls came from, and nothing
 * else. Codex 0.154.0 stamps every `tools/call` with `_meta.threadId`, but spawns its MCP servers with
 * a filtered environment (observed: `HOME, PATH, TERM, TMPDIR, __CF_USER_TEXT_ENCODING` — no
 * `CODEX_HOME`), so the bridge cannot know which Codex home it runs under and does not claim one.
 */
export interface CodexLeaderAnnouncement {
  readonly threadId: string;
}

/**
 * A refused attach, with WHICH refusal it was (design review NB-1), so the cockpit can name the cause
 * and its fix. The message stays path-free, like every error this module throws.
 */
export class CodexAttachError extends Error {
  constructor(
    readonly reason: Exclude<CodexUnreachableReason, 'not-announced'>,
    message: string,
  ) {
    super(message);
  }
}

export interface ConnectedCodexLeader {
  readonly link: CodexAppServerLink & { close(): void };
  readonly threadId: string;
  /** What `thread/resume` said about the thread at attach, seeded into the reaction adapter. */
  readonly state: CodexThreadState;
}

/**
 * THE DISCOVERY RULE (#374). The candidate is fixed by the SERVICE, never by the bridge or the
 * cockpit: the Codex home of the `xezar serve` process — its `CODEX_HOME` when set, otherwise
 * `~/.codex`, which is Codex's own default — and inside it the one measured control socket,
 * `app-server-control/app-server-control.sock`. That candidate is trusted only after, in order:
 *
 *  1. the socket is a Unix socket owned by this user, under a parent directory private to this user;
 *  2. the server listening on it answers `initialize` with that same home (`codexHome`), canonicalised
 *     — so a symlinked or foreign home fails closed;
 *  3. the announced thread is the ONE thread that cwd-filtered `thread/list` (the canonical project
 *     root) and `thread/loaded/list` both name. cwd alone is not enough — two sessions can share a
 *     project — and a saved thread that is not loaded is never resumed into this server.
 *
 * A person who runs Codex under a custom home that `xezar serve` does not share gets the recoverable
 * "cannot reach" blocker; their events stay in the journal and `leader_events` reads them.
 */
export function codexControlHome(env: NodeJS.ProcessEnv = process.env): string {
  return agentHomePaths(env).codex;
}

/**
 * Connect to an already-running shared app-server. This starts no process and accepts no socket
 * path from anyone: `codexHome` comes from the service's own environment (`codexControlHome`).
 * Every error it throws is free of paths, so a caller may log it as it is.
 */
export async function connectCodexLeader(announcement: CodexLeaderAnnouncement, projectRoot: string, codexHome: string): Promise<ConnectedCodexLeader> {
  // A home that cannot be read is where xezar looks, not where this person's Codex runs: the home fix.
  const home = local('the Codex home cannot be read', () => realpathSync(codexHome), 'home');
  const expectedProject = local('the project folder cannot be read', () => realpathSync(projectRoot));
  const socketPath = join(home, CODEX_CONTROL_SOCKET);
  validateControlSocket(socketPath);
  const link = await CodexWsLink.connect(socketPath).catch((error: unknown) => {
    throw new CodexAttachError('app-server', error instanceof Error ? error.message : String(error));
  });
  try {
    const initialized = await link.request('initialize', { clientInfo: { name: 'xezar', version: 'local' } });
    const answered = typeof initialized.codexHome === 'string' ? local('the Codex app-server named a home that cannot be read', () => realpathSync(initialized.codexHome as string), 'home') : undefined;
    if (answered !== home) throw new CodexAttachError('home', 'the Codex app-server did not confirm the Codex home xezar looked in');
    const candidates = await listProjectThreads(link, expectedProject, announcement.threadId);
    // codex-cli 0.154.0's ThreadLoadedListResponse.data is string[], unlike thread/list.
    // Keeping this separate is important: treating loaded ids as thread records silently makes
    // every valid attachment look unloaded.
    const loadedIds = new Set(codexLoadedIds(await link.request('thread/loaded/list', {})));
    if (candidates.length !== 1 || !loadedIds.has(announcement.threadId)) throw new CodexAttachError('thread', 'the announced Codex thread is absent, stale, ambiguous, or not loaded for this project');
    const resumed = await link.request('thread/resume', { threadId: announcement.threadId, excludeTurns: true });
    if (threadIdFrom(resumed) !== announcement.threadId) throw new CodexAttachError('thread', 'the Codex app-server resumed a different thread');
    const state = await codexThreadState(link, announcement.threadId, resumed).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // "Not loaded" is the session's; a state xezar cannot read is the protocol's, with its own fix.
      throw new CodexAttachError(message.includes('not loaded') ? 'thread' : 'state', message);
    });
    // Attaching must not hold the thread: a subscribed xezar link keeps a thread loaded after its TUI
    // exits (measured), so the adapter subscribes again only for each hand-off (`CodexReactionAdapter`).
    await link.request('thread/unsubscribe', { threadId: announcement.threadId });
    return { link, threadId: announcement.threadId, state };
  } catch (error) {
    link.close();
    throw error;
  }
}

/** Every page of cwd-filtered `thread/list` until the announced thread shows up (bounded). */
async function listProjectThreads(link: CodexWsLink, cwd: string, threadId: string): Promise<Array<{ id: string; cwd?: string }>> {
  const matches: Array<{ id: string; cwd?: string }> = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const listed = await link.request('thread/list', { cwd, modelProviders: [], ...(cursor === undefined ? {} : { cursor }) });
    const found = threads(listed).filter((thread) => thread.id === threadId && thread.cwd === cwd);
    matches.push(...found);
    cursor = typeof listed.nextCursor === 'string' && listed.nextCursor.length > 0 ? listed.nextCursor : undefined;
    if (found.length > 0 || cursor === undefined) break;
  }
  return matches;
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

function threadIdFrom(value: Record<string, unknown>): string | undefined {
  if (typeof value.threadId === 'string') return value.threadId;
  const thread = value.thread as Record<string, unknown> | undefined;
  return typeof thread?.id === 'string' ? thread.id : undefined;
}

/**
 * Run a filesystem step and replace an errno failure with `what (CODE)`: the reason, never the path.
 * With a `reason` the failure is a named refusal the cockpit can give its own fix (NB-1).
 */
function local<T>(what: string, step: () => T, reason?: CodexAttachError['reason']): T {
  try {
    return step();
  } catch (err) {
    const message = `${what} (${errnoCode(err)})`;
    throw reason === undefined ? new Error(message) : new CodexAttachError(reason, message);
  }
}

function errnoCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'error';
}

/** Local socket, current user, and a private parent: no world-writable rendezvous point. */
export function validateControlSocket(socketPath: string): void {
  const socket = local('no shared Codex app-server control socket was found in the Codex home', () => lstatSync(socketPath), 'app-server');
  const parent = local('the Codex control socket folder cannot be read', () => statSync(dirname(socketPath)), 'app-server');
  if (!socket.isSocket()) throw new CodexAttachError('app-server', 'the Codex control endpoint is not a Unix socket');
  if (socket.uid !== process.getuid?.()) throw new CodexAttachError('app-server', 'the Codex control socket belongs to another user');
  if (parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) throw new CodexAttachError('app-server', 'the Codex control socket parent is not private to this user');
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
      //
      // `perMessageDeflate: false` is load-bearing. ws offers `Sec-WebSocket-Extensions:
      // permessage-deflate` by default, and codex-cli 0.154.0's app-server hangs up on an Upgrade
      // that carries it (measured: default → "socket hang up", disabled → open). The measured run H
      // framing sent no extension header at all.
      const socket = new WebSocket(`ws+unix://${socketPath}:/`, { maxPayload: MAX_FRAME_BYTES, handshakeTimeout: TIMEOUT_MS, perMessageDeflate: false });
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('timed out connecting to the Codex app-server')); }, TIMEOUT_MS);
      socket.once('open', () => { clearTimeout(timer); resolve(new CodexWsLink(socket)); });
      // ws's own errors name the socket path (`connect ENOENT <path>`); only the reason travels.
      socket.once('error', (error) => { clearTimeout(timer); reject(new Error(`the Codex app-server did not accept xezar’s connection (${errnoCode(error) === 'error' ? error.message : errnoCode(error)})`)); });
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
      // An error ANSWER is a refusal: app-server received the request and turned it away.
      if (message.error !== undefined) pending.reject(new CodexRequestRefused(typeof (message.error as Record<string, unknown>).message === 'string' ? (message.error as Record<string, unknown>).message as string : 'Codex app-server refused the request'));
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
