#!/usr/bin/env node
// Test-only mock of `opencode serve` — speaks just enough of the HTTP+SSE
// API (§4 of agent-event-protocols.md) for the runner wiring test in
// `opencode-ui-mapper.test.ts`: POST /session, GET /event (SSE bus), one
// scripted prompt turn. Deliberately reproduces the real server's ordering
// quirk that motivates the v2 turn-end fix: the HTTP prompt response
// resolves BEFORE the final SSE parts and the `session.idle` — so a correct
// v2 stream must take `turn.completed` from `session.idle`, not from the
// HTTP response (which is where v1 synthesizes its `turn-end`).
//
// `opencode-server-runner.test.ts` (#55) drives the same binary through the
// server-lifecycle failures a `vi.mock` of `node:child_process` cannot reach.
// Every one of those is an opt-in env flag, so the DEFAULT script above stays
// byte-identical to what the mapper test replays:
//
//   MOCK_OPENCODE_IGNORE_SIGTERM=1   handle SIGTERM and keep running — the
//                                    real server's own handler, the shape that
//                                    made #858's SIGKILL escalation necessary.
//   MOCK_OPENCODE_EXIT_BEFORE_LISTEN=1  die before printing a URL: the server
//                                    is gone before the runner's handshake.
//   MOCK_OPENCODE_EXIT_AFTER_IDLE=1  exit cleanly right after `session.idle`,
//                                    so teardown finds the child already dead.
//   MOCK_OPENCODE_DROP_STREAM=1      publish `session.error` + `session.idle`
//                                    mid-turn, then drop the SSE socket.
//   MOCK_OPENCODE_NO_SESSION_ID=1    answer POST /session without an `id`.
//   MOCK_OPENCODE_REJECT_PROMPT=1    answer the prompt POST with HTTP 500.
//   MOCK_OPENCODE_RICH_TURN=1        the wider slice of the bus a real turn
//                                    carries: the user's own message streaming
//                                    back over the same feed, a reasoning part,
//                                    a tool that ends in `error`, and the
//                                    non-JSON / comment frames an SSE client
//                                    must ignore.
//   MOCK_OPENCODE_ASYNC_PROMPT=1     serve `POST /session/:id/prompt_async`,
//                                    the real server's submit-and-return route
//                                    (204, empty body). In this mode the
//                                    BLOCKING `/message` route reproduces the
//                                    #168 wall: it streams the whole turn over
//                                    the SSE feed and then destroys its own
//                                    request socket without ever answering,
//                                    which is exactly what a client sees when
//                                    Node's fetch abandons the request at 300s
//                                    — here in milliseconds. Combine with
//                                    MOCK_OPENCODE_REJECT_PROMPT (both routes
//                                    answer 500) or MOCK_OPENCODE_DROP_STREAM
//                                    (accept, stream, then drop the SSE socket
//                                    without ever going idle).
//   MOCK_OPENCODE_NEVER_ANSWER_PROMPT=1  accept the blocking prompt POST and
//                                    never answer it, holding the socket open
//                                    for ever — the slow local model of #153
//                                    once the 300s transport wall is gone.
//                                    Only the run's own wall clock, `end()` or
//                                    `interrupt()` can end such a turn, which
//                                    is what those tests assert.
//   MOCK_OPENCODE_SIGNAL_LOG=<path>  append every stop signal actually
//                                    received, one per line — SIGKILL cannot
//                                    be caught, so an escalation shows up as
//                                    "one SIGTERM logged, process gone".
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const hostname = arg('--hostname', '127.0.0.1');
const port = Number(arg('--port', '0'));

const ignoreSigterm = process.env.MOCK_OPENCODE_IGNORE_SIGTERM === '1';
const exitBeforeListen = process.env.MOCK_OPENCODE_EXIT_BEFORE_LISTEN === '1';
const exitAfterIdle = process.env.MOCK_OPENCODE_EXIT_AFTER_IDLE === '1';
const dropStream = process.env.MOCK_OPENCODE_DROP_STREAM === '1';
const noSessionId = process.env.MOCK_OPENCODE_NO_SESSION_ID === '1';
const rejectPrompt = process.env.MOCK_OPENCODE_REJECT_PROMPT === '1';
const richTurn = process.env.MOCK_OPENCODE_RICH_TURN === '1';
const asyncPrompt = process.env.MOCK_OPENCODE_ASYNC_PROMPT === '1';
const neverAnswerPrompt = process.env.MOCK_OPENCODE_NEVER_ANSWER_PROMPT === '1';
const signalLog = process.env.MOCK_OPENCODE_SIGNAL_LOG;

const SESSION_ID = 'ses_mock_1';
const MESSAGE_ID = 'msg_mock_1';

let sse = null;
const sendRaw = (frame) => {
  if (sse) sse.write(frame);
};
const send = (event) => {
  sendRaw(`data: ${JSON.stringify(event)}\n\n`);
};
const info = (extra) => ({
  id: MESSAGE_ID,
  sessionID: SESSION_ID,
  role: 'assistant',
  time: { created: 1760000000000 },
  modelID: 'mock-model',
  providerID: 'mock',
  mode: 'build',
  path: { cwd: '/repo', root: '/repo' },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  ...extra,
});

/**
 * The default scripted turn, published on the SSE bus. `respond` is called at
 * the exact point the blocking prompt route answers — BEFORE the final text
 * part and the `session.idle`, like the real server under streaming load. The
 * async route passes a no-op, because it has already answered 204.
 */
const streamDefaultTurn = (respond) => {
  send({ type: 'message.updated', properties: { info: info({}) } });
  send({
    type: 'message.part.updated',
    properties: {
      part: { id: 'prt_mock_t1', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: 'Checking the working tree.' },
    },
  });
  send({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt_mock_c1',
        messageID: MESSAGE_ID,
        sessionID: SESSION_ID,
        type: 'tool',
        callID: 'call_mock_1',
        tool: 'bash',
        state: { status: 'pending', input: { command: 'git status --short' }, raw: '{}' },
      },
    },
  });
  send({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt_mock_c1',
        messageID: MESSAGE_ID,
        sessionID: SESSION_ID,
        type: 'tool',
        callID: 'call_mock_1',
        tool: 'bash',
        state: { status: 'running', input: { command: 'git status --short' }, title: 'git status --short', time: { start: 1760000000100 } },
      },
    },
  });
  send({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt_mock_c1',
        messageID: MESSAGE_ID,
        sessionID: SESSION_ID,
        type: 'tool',
        callID: 'call_mock_1',
        tool: 'bash',
        state: {
          status: 'completed',
          input: { command: 'git status --short' },
          output: ' M src/example.ts\n',
          title: 'git status --short',
          metadata: { exit: 0 },
          time: { start: 1760000000100, end: 1760000000400 },
        },
      },
    },
  });
  send({
    type: 'message.updated',
    properties: {
      info: info({ cost: 0.0021, tokens: { input: 1200, output: 300, reasoning: 0, cache: { read: 0, write: 0 } } }),
    },
  });
  respond();
  setTimeout(() => {
    send({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_mock_t2',
          messageID: MESSAGE_ID,
          sessionID: SESSION_ID,
          type: 'text',
          text: 'Done.',
          time: { start: 1760000000500, end: 1760000000600 },
        },
      },
    });
  }, 30);
  setTimeout(() => {
    send({ type: 'session.idle', properties: { sessionID: SESSION_ID } });
    // A server that finishes and shuts itself down — teardown then finds
    // the child already gone and must send no signal at all.
    if (exitAfterIdle) setTimeout(() => process.exit(0), 30);
  }, 90);
};

const server = createServer((req, res) => {
  const url = req.url ?? '';
  if (req.method === 'GET' && url.startsWith('/event')) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    sse = res;
    send({ type: 'server.connected', properties: {} });
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (req.method === 'POST' && url === '/session') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // A server that answers the create call but names no session leaves the
      // runner with nothing to prompt — it must say so, not press on.
      res.end(JSON.stringify(noSessionId ? { title: 'xezar task' } : { id: SESSION_ID, title: 'xezar task' }));
      return;
    }
    if (req.method === 'POST' && url === `/session/${SESSION_ID}/message` && rejectPrompt) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no provider configured' }));
      return;
    }
    if (req.method === 'POST' && url === `/session/${SESSION_ID}/prompt_async` && rejectPrompt) {
      // A refusal reads the same on either route — the runner must report it
      // just as clearly as it does on the blocking one.
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no provider configured' }));
      return;
    }
    if (req.method === 'POST' && url === `/session/${SESSION_ID}/prompt_async` && asyncPrompt) {
      // Submit and return: 204, no body, before a single event is published.
      res.writeHead(204);
      res.end();
      if (dropStream) {
        // Accepted, streamed a little, then the feed dies and no `session.idle`
        // ever arrives. The turn must be released by the feed ending, not hang.
        send({ type: 'message.updated', properties: { info: info({}) } });
        send({
          type: 'message.part.updated',
          properties: {
            part: { id: 'prt_mock_t1', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: 'Partial answer', time: { start: 1760000000500, end: 1760000000600 } },
          },
        });
        setTimeout(() => {
          if (sse) {
            sse.destroy();
            sse = null;
          }
        }, 30);
        return;
      }
      streamDefaultTurn(() => {});
      return;
    }
    if (req.method === 'POST' && url === `/session/${SESSION_ID}/message` && asyncPrompt) {
      // The blocking route WITH the wall the async route exists to avoid: the
      // turn streams over the SSE feed exactly as it always does, and this
      // request is never answered — its socket is destroyed instead, which is
      // what the client sees when Node's fetch abandons the request at 300s.
      // A runner that still waits here loses a healthy turn (#168).
      streamDefaultTurn(() => setTimeout(() => res.destroy(), 20));
      return;
    }
    if (req.method === 'POST' && url === `/session/${SESSION_ID}/message` && neverAnswerPrompt) {
      // Accepted and never answered — the socket just stays open. Since #153
      // the client puts no wall of its own here, so the ONLY things that can
      // end this turn are the run's wall clock, `end()` and `interrupt()`;
      // each of them kills this server, which closes the socket.
      return;
    }
    if (req.method === 'POST' && url === `/session/${SESSION_ID}/message` && richTurn) {
      // The user's own prompt streams back over the same server-wide feed…
      send({
        type: 'message.updated',
        properties: { info: { id: 'msg_mock_u1', sessionID: SESSION_ID, role: 'user', time: { created: 1760000000000 } } },
      });
      send({
        type: 'message.part.updated',
        properties: {
          part: { id: 'prt_user_1', messageID: 'msg_mock_u1', sessionID: SESSION_ID, type: 'text', text: 'check the working tree' },
        },
      });
      // …interleaved with frames an SSE client must survive: a comment
      // keep-alive with no `data:` line, and a truncated JSON payload.
      sendRaw(': keep-alive\n\n');
      sendRaw('data: {"type":"message.part\n\n');
      send({ type: 'message.created', properties: { info: info({}) } });
      send({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_mock_r1',
            messageID: MESSAGE_ID,
            sessionID: SESSION_ID,
            type: 'reasoning',
            text: 'The tree may be dirty.',
            time: { start: 1760000000050, end: 1760000000080 },
          },
        },
      });
      send({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_mock_c9',
            messageID: MESSAGE_ID,
            sessionID: SESSION_ID,
            type: 'tool',
            callID: 'call_mock_9',
            tool: 'bash',
            state: { status: 'pending', input: { command: 'npm test' }, raw: '{}' },
          },
        },
      });
      // The error state carries no `input` and no `title` (§4.2).
      send({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_mock_c9',
            messageID: MESSAGE_ID,
            sessionID: SESSION_ID,
            type: 'tool',
            callID: 'call_mock_9',
            tool: 'bash',
            state: { status: 'error', error: 'command not found: npm' },
          },
        },
      });
      send({
        type: 'message.completed',
        properties: {
          info: info({ cost: 0.004, tokens: { input: 900, output: 100, reasoning: 40, cache: { read: 0, write: 0 } } }),
        },
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ info: info({ cost: 0.004 }), parts: [] }));
      setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 30);
      return;
    }
    if (req.method === 'POST' && url === `/session/${SESSION_ID}/message` && dropStream) {
      // The provider connection dies mid-turn: the real server publishes the
      // failure on the bus, goes idle (§4.1 — idle is THE turn-end signal, and
      // a turn that saw `session.error` closes as stopReason 'error'), answers
      // the prompt POST, and only then does the SSE socket itself go away.
      send({ type: 'message.updated', properties: { info: info({}) } });
      send({
        type: 'message.part.updated',
        properties: {
          part: { id: 'prt_mock_t1', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: 'Partial answer' },
        },
      });
      send({
        type: 'session.error',
        properties: {
          sessionID: SESSION_ID,
          error: { name: 'ProviderError', data: { message: 'connection closed mid-stream' } },
        },
      });
      send({ type: 'session.idle', properties: { sessionID: SESSION_ID } });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ info: info({}), parts: [] }));
      setTimeout(() => {
        if (sse) {
          sse.destroy();
          sse = null;
        }
      }, 50);
      return;
    }
    if (req.method === 'POST' && url === `/session/${SESSION_ID}/message`) {
      // Respond to the prompt POST BEFORE the final text part and the idle
      // signal, like the real server under streaming load.
      streamDefaultTurn(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ info: info({ cost: 0.0021 }), parts: [] }));
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});

const noteSignal = (name) => {
  if (!signalLog) return;
  try {
    appendFileSync(signalLog, `${name}\n`);
  } catch {
    // The test owns the path; a missing directory must not change the shape
    // of the teardown being observed.
  }
};

process.on('SIGTERM', () => {
  noteSignal('SIGTERM');
  // The real `opencode serve` installs its own SIGTERM handler. Under
  // MOCK_OPENCODE_IGNORE_SIGTERM it keeps running after handling the signal —
  // the #858 shape where only the SIGKILL escalation can end the process.
  if (!ignoreSigterm) process.exit(0);
});

if (exitBeforeListen) {
  // `opencode serve` dies before it ever prints a URL (port taken, bad config):
  // the runner's handshake must surface that as a handled session error.
  process.stderr.write('opencode: failed to start server\n');
  process.exit(1);
}

server.listen(port, hostname, () => {
  // The runner reads the bound URL back from stdout, like the real server.
  console.log(`opencode server listening on http://${hostname}:${port}`);
});
