import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { McpJournalAppendInput, McpJournalRow } from '@qodeca/xezar-contract';

import { ProjectOwnership } from '../../workspace/project-owner.ts';
import { EventController, type EventDispatch } from '../event-controller.ts';
import { EventJournal } from '../event-journal.ts';
import { OPENCODE_DELIVERY_ROUTES, OpenCodeDeliveryBlocked, OpenCodeReactionAdapter, renderDispatch } from './opencode.ts';

/**
 * #110 — the OpenCode reaction adapter, against a fake `opencode serve` that answers the routes
 * OpenCode 1.18.30 answers (shapes taken from its own `/doc` and from the runtime record in
 * `docs/features/mcp-server/mcp-adapter-evidence-opencode.md`). Offline: no OpenCode binary, no
 * model, no login, so it runs with `XEZ_DRY_RUN=1` exactly as without it.
 *
 * The fake reproduces the behaviours the adapter exists to handle: a busy session, a pending
 * permission prompt, a submission's frames arriving on `/event`, a lost `204`, and a turn that
 * does or does not follow a submission. It also records every request, so a test can prove what the
 * adapter NEVER called (`/tui/*`, `/permission/:id/reply`, a second `prompt_async`).
 */

const PROJECT_ROOT = '/work/fixture-project';
const SESSION = 'ses_fixture0000000000000001';
const ROLE = 'xezar base role instruction (fixture)';

interface Submission {
  body: {
    agent?: string;
    system?: string;
    messageID?: string;
    parts: { type: string; text: string; metadata?: { xezar?: { rows: string[]; toSeq: number | null; source: string } } }[];
  };
  messageId: string;
}

class FakeOpenCode {
  server!: Server;
  baseUrl = '';
  requests: string[] = [];
  submissions: Submission[] = [];
  status: 'idle' | 'busy' = 'idle';
  permissions: { id: string; sessionID: string; permission: string }[] = [];
  questions: { id: string; sessionID: string }[] = [];
  directory = PROJECT_ROOT;
  sessionExists = true;
  /** Whether a submission is followed by a model turn (an assistant message answering it). */
  react = true;
  /** Accept the next submission but destroy the connection instead of answering (a lost 204). */
  loseNextAnswer = false;
  /** Answer prompt_async like an OpenCode too old to have it: 200 with its web UI. */
  noAsyncRoute = false;
  history: { info: { id: string; role: string; parentID?: string }; parts: unknown[] }[] = [];
  #streams = new Set<ServerResponse>();
  #ids = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const stream of this.#streams) stream.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  emit(type: string, properties: Record<string, unknown>): void {
    const frame = `data: ${JSON.stringify({ id: `evt_${++this.#ids}`, type, properties })}\n\n`;
    for (const stream of this.#streams) stream.write(frame);
  }

  /** A turn ends: OpenCode reports the session idle. */
  goIdle(): void {
    this.status = 'idle';
    this.emit('session.status', { sessionID: SESSION, status: { type: 'idle' } });
    this.emit('session.idle', { sessionID: SESSION });
  }

  replyPermission(id: string): void {
    this.permissions = this.permissions.filter((p) => p.id !== id);
    this.emit('permission.replied', { sessionID: SESSION, requestID: id, reply: 'reject' });
  }

  get streams(): number {
    return this.#streams.size;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.baseUrl);
    const route = `${req.method} ${url.pathname}`;
    this.requests.push(route);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };

    if (route === 'GET /event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
      this.#streams.add(res);
      res.on('close', () => this.#streams.delete(res));
      return;
    }
    if (route === `GET /session/${SESSION}`) {
      return this.sessionExists ? json(200, { id: SESSION, directory: this.directory }) : json(404, { name: 'NotFoundError' });
    }
    if (route === 'GET /session/status') return json(200, this.status === 'idle' ? {} : { [SESSION]: { type: this.status } });
    if (route === 'GET /permission') return json(200, this.permissions);
    if (route === 'GET /question') return json(200, this.questions);
    if (route === `GET /session/${SESSION}/message`) {
      const limit = Number(url.searchParams.get('limit') ?? this.history.length);
      return json(200, this.history.slice(-limit));
    }
    if (route === `POST /session/${SESSION}/prompt_async`) {
      if (!this.sessionExists) return json(404, { name: 'NotFoundError' });
      if (this.noAsyncRoute) {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<html>opencode web ui</html>');
        return;
      }
      const body = JSON.parse(raw) as Submission['body'];
      const messageId = `msg_user_${++this.#ids}`;
      this.submissions.push({ body, messageId });
      this.history.push({ info: { id: messageId, role: 'user' }, parts: body.parts.map((p) => ({ ...p, sessionID: SESSION, messageID: messageId })) });
      // Real OpenCode emits the submission's frames around the time it answers; emit them first.
      this.emit('message.updated', { sessionID: SESSION, info: { id: messageId, sessionID: SESSION, role: 'user' } });
      for (const part of body.parts) this.emit('message.part.updated', { sessionID: SESSION, part: { ...part, sessionID: SESSION, messageID: messageId } });
      if (this.loseNextAnswer) {
        this.loseNextAnswer = false;
        req.socket.destroy();
      } else {
        res.writeHead(204).end();
      }
      if (this.react) {
        const assistant = `msg_asst_${++this.#ids}`;
        this.history.push({ info: { id: assistant, role: 'assistant', parentID: messageId }, parts: [] });
        this.status = 'busy';
        this.emit('session.status', { sessionID: SESSION, status: { type: 'busy' } });
        this.emit('message.updated', { sessionID: SESSION, info: { id: assistant, sessionID: SESSION, role: 'assistant', parentID: messageId } });
        this.goIdle();
      }
      return;
    }
    json(404, { name: 'NotFoundError', route });
  }
}

let oc: FakeOpenCode;
let adapters: OpenCodeReactionAdapter[] = [];

beforeEach(async () => {
  oc = new FakeOpenCode();
  await oc.start();
});

afterEach(async () => {
  for (const adapter of adapters.splice(0)) adapter.close();
  await oc.stop();
});

function adapterFor(over: Partial<ConstructorParameters<typeof OpenCodeReactionAdapter>[0]> = {}) {
  const reactions: number[] = [];
  const adapter = new OpenCodeReactionAdapter({
    target: { baseUrl: oc.baseUrl, sessionId: SESSION },
    projectRoot: PROJECT_ROOT,
    roleInstruction: ROLE,
    agent: 'leader',
    onReaction: (seq) => reactions.push(seq),
    ...over,
  });
  adapters.push(adapter);
  return { adapter, reactions };
}

let seq = 0;
function row(over: Partial<McpJournalRow> = {}): McpJournalRow {
  seq++;
  return {
    eventId: `alpha:${seq}`,
    journalSeq: seq,
    ts: `2026-09-11T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    projectId: 'alpha',
    category: 'E-01',
    kind: 'task.terminal',
    subject: { type: 'run', id: `run-${seq}`, version: null },
    origin: 'system',
    causedBy: null,
    summary: `task ${seq} finished`,
    ...over,
  } as McpJournalRow;
}

const dispatchOf = (...events: McpJournalRow[]): EventDispatch => ({ projectId: 'alpha', events });
const live = () => new AbortController().signal;
const until = async (pred: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('the delivery hierarchy — prompt_async is the route, terminal input is refused', () => {
  it('records the § 12 order: native not adopted, prompt_async adopted, terminal refused', () => {
    expect(OPENCODE_DELIVERY_ROUTES.map((r) => [r.tier, r.status])).toEqual([
      [1, 'not-adopted'],
      [2, 'adopted'],
      [3, 'refused'],
    ]);
  });

  it('submits one dispatch through POST /session/:id/prompt_async and never touches a /tui/ route', async () => {
    const { adapter } = adapterFor();
    await adapter.deliver(dispatchOf(row(), row()), live());

    expect(oc.submissions).toHaveLength(1);
    expect(oc.requests.filter((r) => r.startsWith('POST'))).toEqual([`POST /session/${SESSION}/prompt_async`]);
    expect(oc.requests.some((r) => r.includes('/tui/'))).toBe(false);
    expect(oc.requests.some((r) => r === 'POST /session')).toBe(false); // never a second leader session
  });

  it('names xezar as the source and says the event is not a user instruction or approval', async () => {
    const { adapter } = adapterFor();
    const human = row({ origin: 'human', category: 'E-04', kind: 'goal.changed', summary: 'the human narrowed the goal' });
    await adapter.deliver(dispatchOf(human), live());

    const text = oc.submissions[0]!.body.parts[0]!.text;
    expect(text.split('\n')[0]).toBe('[xezar event notification]');
    expect(text).toContain('Source: xezar, project alpha');
    expect(text).toContain('not a message from the user, not an instruction and not an approval');
    expect(text).toContain(`${human.eventId} E-04 goal.changed run ${human.subject.id} (origin human): the human narrowed the goal`);
    expect(oc.submissions[0]!.body.parts[0]!.metadata?.xezar).toEqual({
      source: 'xezar',
      projectId: 'alpha',
      rows: [`${human.eventId}@${human.ts}`],
      toSeq: human.journalSeq,
    });
  });

  it('states a gap the controller detected, even with no rows to carry', async () => {
    const { adapter } = adapterFor();
    const recovery = { required: 'current-state' as const, oldestSeq: 40, latestSeq: 90, message: 'Some events are gone.' };
    await adapter.deliver({ projectId: 'alpha', events: [], recovery }, live());
    expect(oc.submissions[0]!.body.parts[0]!.text).toContain('Gap: Some events are gone. (oldest retained 40, latest 90).');
    expect(renderDispatch({ projectId: 'alpha', events: [], recovery }, [])).not.toContain('Significant events');
  });
});

describe('role instruction — system and agent re-sent with every message (resume)', () => {
  it('sends `system` = the xezar role instruction and `agent` on the first AND every later submission', async () => {
    const { adapter } = adapterFor();
    await adapter.deliver(dispatchOf(row()), live());
    await adapter.deliver(dispatchOf(row()), live());
    // A resumed adapter (new instance, same session) re-supplies both too.
    const { adapter: resumed } = adapterFor();
    await resumed.deliver(dispatchOf(row()), live());

    expect(oc.submissions).toHaveLength(3);
    for (const { body } of oc.submissions) {
      expect(body.system).toBe(ROLE);
      expect(body.agent).toBe('leader');
    }
  });

  it('omits `agent` when none is configured, and still sends `system`', async () => {
    const { adapter } = adapterFor({ agent: undefined });
    await adapter.deliver(dispatchOf(row()), live());
    expect(oc.submissions[0]!.body).not.toHaveProperty('agent');
    expect(oc.submissions[0]!.body.system).toBe(ROLE);
  });

  it('never reuses a messageID (OpenCode appends into the old message instead of starting a turn)', async () => {
    const { adapter } = adapterFor();
    await adapter.deliver(dispatchOf(row()), live());
    await adapter.deliver(dispatchOf(row()), live());
    expect(oc.submissions.every(({ body }) => body.messageID === undefined)).toBe(true);
  });
});

describe('delivery is not reaction (F-20)', () => {
  it('reports a reaction only when OpenCode starts the assistant message answering the submission', async () => {
    const { adapter, reactions } = adapterFor();
    const rows = [row(), row(), row()];
    await adapter.deliver(dispatchOf(...rows), live());
    await until(() => reactions.length === 1);
    expect(reactions).toEqual([rows[2]!.journalSeq]);
  });

  it('resolves delivery and reports NO reaction when the client accepted the event but no turn started', async () => {
    oc.react = false;
    const { adapter, reactions } = adapterFor();
    await adapter.deliver(dispatchOf(row()), live());
    await settle();
    expect(oc.submissions).toHaveLength(1);
    expect(reactions).toEqual([]);
    expect(adapter.status().turnsAwaited).toBe(1);
  });

  it('never counts an unrelated assistant message (another turn) as the reaction', async () => {
    oc.react = false;
    const { adapter, reactions } = adapterFor();
    await adapter.deliver(dispatchOf(row()), live());
    oc.emit('message.updated', { sessionID: SESSION, info: { id: 'msg_x', sessionID: SESSION, role: 'assistant', parentID: 'msg_someone_else' } });
    await settle();
    expect(reactions).toEqual([]);
  });
});

describe('the xezar project feed is the only trigger — OpenCode’s own stream is observed, never obeyed', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'xez-opencode-adapter-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  const input = (n: number, over: Partial<McpJournalAppendInput> = {}): McpJournalAppendInput => ({
    category: 'E-01',
    kind: 'task.terminal',
    subject: { type: 'run', id: `run-${n}`, version: null },
    origin: 'system',
    causedBy: null,
    summary: `task ${n} finished`,
    ...over,
  });

  it('a row appended to the xezar journal reaches OpenCode through the controller and its turn is recorded as the reaction', async () => {
    const journal = EventJournal.open({ dataDir, projectId: 'alpha', secretValues: [], warn: () => {} });
    const owner = new ProjectOwnership({ dataDir, projectId: 'alpha', autoRenew: false });
    await owner.acquire('leader-1');
    let controller: EventController | undefined;
    const { adapter } = adapterFor({ onReaction: (s) => controller?.recordReaction(s) });
    const started = EventController.start({ journal, ownership: owner, sessionKey: 'leader-1', adapter, warn: () => {} });
    if (started.outcome !== 'started') throw new Error(`controller ${started.outcome}`);
    const running = started.controller;
    controller = running;
    try {
      // OpenCode's own activity — frames of every kind the adapter reads — triggers nothing.
      await until(() => oc.streams > 0 || oc.submissions.length === 0);
      oc.emit('mcp.tools.changed', { server: 'xezar' });
      oc.emit('session.idle', { sessionID: SESSION });
      oc.emit('message.updated', { sessionID: SESSION, info: { id: 'msg_u', sessionID: SESSION, role: 'user' } });
      await settle();
      expect(oc.submissions).toHaveLength(0);

      const appended = journal.append(input(1))!;
      await until(() => running.status().reactedSeq === appended.journalSeq);
      expect(oc.submissions).toHaveLength(1);
      expect(oc.submissions[0]!.body.parts[0]!.text).toContain(appended.eventId);
      expect(running.status()).toMatchObject({ deliveredSeq: 1, reactedSeq: 1, ackedSeq: 0 });
    } finally {
      running.close();
      owner.dispose();
      journal.close();
    }
  });

  it('drops only the leader’s own echo (origin leader + own operation), never a row for the same run from a human', async () => {
    const own = 'op.leader.0001';
    const { adapter } = adapterFor({ isOwnOperation: (id) => id === own });
    const echo = row({ origin: 'leader', causedBy: own, subject: { type: 'run', id: 'run-7', version: null } });
    const human = row({ origin: 'human', subject: { type: 'run', id: 'run-7', version: null } });
    await adapter.deliver(dispatchOf(echo), live());
    expect(oc.submissions).toHaveLength(0);
    await adapter.deliver(dispatchOf(echo, human), live());
    expect(oc.submissions).toHaveLength(1);
    expect(oc.submissions[0]!.body.parts[0]!.metadata?.xezar?.rows).toEqual([`${human.eventId}@${human.ts}`]);
  });
});

describe('never into an active turn, a pending permission prompt or a pending question', () => {
  it('waits for session.idle while the session is busy, then submits', async () => {
    oc.status = 'busy';
    const { adapter } = adapterFor();
    const delivered = adapter.deliver(dispatchOf(row()), live());
    await settle();
    expect(oc.submissions).toHaveLength(0);
    oc.goIdle();
    await delivered;
    expect(oc.submissions).toHaveLength(1);
  });

  it('waits while a permission prompt is pending for the session, never answers it, and submits after the user did', async () => {
    oc.permissions = [{ id: 'per_1', sessionID: SESSION, permission: 'bash' }];
    const { adapter } = adapterFor();
    const delivered = adapter.deliver(dispatchOf(row()), live());
    await settle();
    // Other OpenCode activity while the prompt is open does not release the wait.
    oc.emit('session.idle', { sessionID: SESSION });
    await settle();
    expect(oc.submissions).toHaveLength(0);
    oc.replyPermission('per_1');
    await delivered;
    expect(oc.submissions).toHaveLength(1);
    expect(oc.requests.some((r) => r.includes('/permission/') || r.includes('/permissions/'))).toBe(false);
  });

  it('waits while a question is pending for the session', async () => {
    oc.questions = [{ id: 'que_1', sessionID: SESSION }];
    const { adapter } = adapterFor();
    const delivered = adapter.deliver(dispatchOf(row()), live());
    await settle();
    expect(oc.submissions).toHaveLength(0);
    oc.questions = [];
    oc.emit('question.replied', { sessionID: SESSION, requestID: 'que_1' });
    await delivered;
    expect(oc.submissions).toHaveLength(1);
  });

  it('is not held by another session’s permission prompt', async () => {
    oc.permissions = [{ id: 'per_2', sessionID: 'ses_other', permission: 'bash' }];
    const { adapter } = adapterFor();
    await adapter.deliver(dispatchOf(row()), live());
    expect(oc.submissions).toHaveLength(1);
  });

  it('gives up when the controller aborts the attempt, having submitted nothing', async () => {
    oc.status = 'busy';
    const { adapter } = adapterFor();
    const attempt = new AbortController();
    const delivered = adapter.deliver(dispatchOf(row()), attempt.signal);
    await settle();
    attempt.abort(new Error('attempt timed out'));
    await expect(delivered).rejects.toThrow('attempt timed out');
    expect(oc.submissions).toHaveLength(0);
  });
});

describe('duplicate prevention — never two turns for one row', () => {
  it('a re-dispatch of rows already submitted is a no-op', async () => {
    const { adapter } = adapterFor();
    const rows = [row(), row()];
    await adapter.deliver(dispatchOf(...rows), live());
    await adapter.deliver(dispatchOf(...rows), live());
    expect(oc.submissions).toHaveLength(1);
    // A dispatch that overlaps carries only the new row.
    const next = row();
    await adapter.deliver(dispatchOf(rows[1]!, next), live());
    expect(oc.submissions).toHaveLength(2);
    expect(oc.submissions[1]!.body.parts[0]!.metadata?.xezar?.rows).toEqual([`${next.eventId}@${next.ts}`]);
  });

  it('after a restart, rows the session history already carries are not submitted again — and their turn is still reported', async () => {
    const rows = [row(), row()];
    await adapterFor().adapter.deliver(dispatchOf(...rows), live());
    const { adapter: restarted, reactions } = adapterFor();
    await restarted.deliver(dispatchOf(...rows), live());
    expect(oc.submissions).toHaveLength(1);
    expect(reactions).toEqual([rows[1]!.journalSeq]);
  });

  it('a lost 204 does not produce a second submission on retry', async () => {
    oc.loseNextAnswer = true;
    const { adapter } = adapterFor();
    const rows = [row()];
    await expect(adapter.deliver(dispatchOf(...rows), live())).rejects.toBeInstanceOf(Error);
    await adapter.deliver(dispatchOf(...rows), live());
    expect(oc.submissions).toHaveLength(1);
  });

  it('a row from a recreated journal (same seq, new ts) is not mistaken for one already submitted', async () => {
    const { adapter } = adapterFor();
    const old = row();
    await adapter.deliver(dispatchOf(old), live());
    await adapter.deliver(dispatchOf({ ...old, ts: '2026-09-12T00:00:00.000Z' }), live());
    expect(oc.submissions).toHaveLength(2);
  });
});

describe('recoverable blockers — targeting is proven, never guessed', () => {
  it('no target: blocked, recoverable, nothing sent', async () => {
    const { adapter } = adapterFor({ target: undefined });
    const err = await adapter.deliver(dispatchOf(row()), live()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenCodeDeliveryBlocked);
    expect((err as OpenCodeDeliveryBlocked).blocker).toMatchObject({ code: 'no-target', recoverable: true });
    expect(adapter.status()).toMatchObject({ route: 'blocked', blocker: { code: 'no-target' } });
    expect(oc.requests).toEqual([]);
  });

  it('a session that does not exist is blocked, and the adapter does not create one', async () => {
    oc.sessionExists = false;
    const { adapter } = adapterFor();
    const err = await adapter.deliver(dispatchOf(row()), live()).catch((e: unknown) => e);
    expect((err as OpenCodeDeliveryBlocked).blocker.code).toBe('session-not-found');
    expect(oc.requests.filter((r) => r.startsWith('POST'))).toEqual([]);
  });

  it('a session opened in another directory is blocked as the wrong project', async () => {
    oc.directory = '/work/another-project';
    const { adapter } = adapterFor();
    const err = await adapter.deliver(dispatchOf(row()), live()).catch((e: unknown) => e);
    expect((err as OpenCodeDeliveryBlocked).blocker.code).toBe('wrong-project');
    expect(oc.submissions).toHaveLength(0);
  });

  it('an OpenCode without prompt_async (serves HTML there) is blocked, never answered with terminal input', async () => {
    oc.noAsyncRoute = true;
    const { adapter } = adapterFor();
    const err = await adapter.deliver(dispatchOf(row()), live()).catch((e: unknown) => e);
    expect((err as OpenCodeDeliveryBlocked).blocker.code).toBe('no-async-route');
    expect(oc.requests.some((r) => r.includes('/tui/'))).toBe(false);
  });

  it('an unreachable server is blocked, and the block clears once the session is reachable again', async () => {
    const { adapter } = adapterFor({ target: { baseUrl: 'http://127.0.0.1:9', sessionId: SESSION } });
    const err = await adapter.deliver(dispatchOf(row()), live()).catch((e: unknown) => e);
    expect((err as OpenCodeDeliveryBlocked).blocker.code).toBe('server-unreachable');

    const { adapter: healthy } = adapterFor();
    await healthy.heartbeat(live());
    expect(healthy.status().route).toBe('prompt_async');
  });

  it('the heartbeat is non-model: it reads the session and never submits', async () => {
    const { adapter } = adapterFor();
    await adapter.heartbeat(live());
    await adapter.heartbeat(live());
    expect(oc.requests).toEqual([`GET /session/${SESSION}`, `GET /session/${SESSION}`]);
    oc.sessionExists = false;
    await expect(adapter.heartbeat(live())).rejects.toBeInstanceOf(OpenCodeDeliveryBlocked);
  });
});

describe('AGENTS.md — no XDG_CONFIG_HOME, no environment, no file writes', () => {
  const source = readFileSync(new URL('./opencode.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('never names XDG_CONFIG_HOME (or any XDG variable) anywhere in the adapter, comments included', () => {
    expect(source).not.toMatch(/XDG_/);
  });

  it('reads and writes no environment variable and imports nothing that writes files or spawns processes', () => {
    expect(code).not.toMatch(/process\.env|process\.|child_process|node:fs|from 'fs'|writeFile|appendFile|spawn|execFile/);
  });

  it('leaves process.env exactly as it found it across a full delivery, reaction and heartbeat', async () => {
    const before = { ...process.env };
    const { adapter, reactions } = adapterFor();
    await adapter.deliver(dispatchOf(row()), live());
    await until(() => reactions.length === 1);
    await adapter.heartbeat(live());
    expect(process.env).toEqual(before);
    expect(process.env.XDG_CONFIG_HOME).toBe(before.XDG_CONFIG_HOME);
  });
});
