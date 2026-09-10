import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentSession } from './agent-runner.ts';
import type { UiEvent } from './ui-events.ts';
import { KILL_GRACE_MS, OpencodeServerRunner } from './opencode-server-runner.ts';

/**
 * #55 — this suite used to `vi.mock('node:child_process')` and hand the runner
 * a hand-built EventEmitter. That tests the runner's BELIEFS about a process:
 * it can prove `child.kill('SIGKILL')` was called, but never that the server
 * actually died. The failures users notice — a server that ignores SIGTERM and
 * is left running, one that dies before the handshake, a socket that drops
 * mid-turn — all live on the other side of that seam.
 *
 * So every test here spawns the repository's own wire-faithful mock server
 * (`__fixtures__/opencode/mock-opencode-serve.mjs`, the same binary the mapper
 * test replays) as a REAL child process, the way
 * `codex-app-server-runner.test.ts` already does for Codex. Teardown is
 * asserted against the operating system: `process.kill(pid, 0)` throwing ESRCH
 * is the proof, and the mock's signal log records which signals it really
 * received. SIGKILL cannot be caught, so an escalation reads as "exactly one
 * SIGTERM logged, and the process is gone anyway".
 */

const mockBin = fileURLToPath(new URL('./__fixtures__/opencode/mock-opencode-serve.mjs', import.meta.url));

/** Every pid this file spawns, so nothing survives the suite (#55's whole point). */
const spawned = new Set<number>();
/** Pids that were still alive when their test finished — force-killed for
 *  hygiene, then reported by the final sweep so a leak cannot pass quietly. */
const leaked: number[] = [];

let signalLog = '';
let tmpDir = '';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'xez-opencode-mock-'));
  signalLog = join(tmpDir, 'signals.log');
});

afterEach(() => {
  try {
    for (const pid of spawned) {
      if (!isAlive(pid)) continue;
      leaked.push(pid);
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already reaped between the check and the signal.
      }
    }
    spawned.clear();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

afterAll(() => {
  // The orphaned-agent-process check: no mock server may outlive this file.
  expect(leaked).toEqual([]);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

/** Stop signals the mock actually caught, in order. */
function signalsSeen(): string[] {
  try {
    return readFileSync(signalLog, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

interface Started {
  session: AgentSession;
  pid: number;
  v1: AgentEvent[];
  v2: UiEvent[];
}

/** Start a session against the real mock and register its pid for the sweep. */
function start(
  opts: {
    env?: Record<string, string>;
    timeoutMs?: number;
    autoEnd?: boolean;
    model?: string;
    runner?: OpencodeServerRunner;
  } = {},
): Started {
  const runner = opts.runner ?? new OpencodeServerRunner({ bin: mockBin, timeoutMs: opts.timeoutMs ?? 0 });
  const v1: AgentEvent[] = [];
  const v2: UiEvent[] = [];
  const session = runner.startSession(
    {
      userPrompt: 'check the working tree',
      cwd: process.cwd(),
      env: { MOCK_OPENCODE_SIGNAL_LOG: signalLog, ...opts.env },
      ...(opts.model ? { model: opts.model } : {}),
    },
    (event) => v1.push(event),
    { onUiEvent: (event) => v2.push(event), ...(opts.autoEnd ? { autoEndAfterFirstTurn: true } : {}) },
  );
  const pid = session.pid;
  expect(pid).toBeTypeOf('number');
  spawned.add(pid as number);
  return { session, pid: pid as number, v1, v2 };
}

describe('a normal session against the real opencode mock server', () => {
  it('produces the expected v1 and v2 event streams and reaps the server', async () => {
    const { session, pid, v1, v2 } = start();
    try {
      await until(() => v2.some((e) => e.type === 'turn.completed'), 'the turn to complete');
      session.end();
      const result = await session.result;

      // v1, unchanged by anything this suite does. Only the two ends of the
      // stream are ordered: the HTTP prompt response (which is what v1
      // synthesizes `turn-end` from) and the SSE bus are separate sockets, so
      // where `turn-end` lands among the streamed events is genuinely racy.
      const counts = new Map<string, number>();
      for (const event of v1) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
      expect(Object.fromEntries(counts)).toEqual({
        session: 1,
        text: 2,
        'tool-call': 1,
        'tool-result': 1,
        'token-usage': 1,
        cost: 1,
        'turn-end': 1,
        done: 1,
      });
      expect(v1[0]).toEqual({ type: 'session', sessionId: 'ses_mock_1' });
      expect(v1.at(-1)).toEqual({ type: 'done' });
      expect(v1).toContainEqual({
        type: 'tool-call',
        id: 'prt_mock_c1',
        tool: 'bash',
        input: { command: 'git status --short' },
      });
      expect(v1).toContainEqual({
        type: 'tool-result',
        toolCallId: 'prt_mock_c1',
        result: ' M src/example.ts\n',
        isError: false,
      });
      expect(v1).toContainEqual({ type: 'token-usage', tokensUsed: 1500 });
      // Both blocks land in the transcript. Their ORDER is deliberately not
      // pinned: `prt_mock_t1` never receives a `time.end` (the mock reproduces
      // that real-server shape), so it stays in the coalescer until a flush,
      // while `prt_mock_t2` completes on its own — and which flush wins depends
      // on the same HTTP-vs-SSE race as `turn-end` above.
      expect([...result.text.split('\n')].sort()).toEqual(['Checking the working tree.', 'Done.']);
      expect(result.tokensUsed).toBe(1500);
      expect(result.sessionId).toBe('ses_mock_1');

      // v2 rides alongside and takes its turn end from `session.idle`.
      expect(v2[0]).toEqual({ type: 'session.started', sessionId: 'ses_mock_1', backend: 'opencode' });
      expect(v2[1]).toEqual({ type: 'turn.started', turnId: 'turn_1' });
      expect(v2).toContainEqual({
        type: 'item.delta',
        itemId: 'prt_mock_t1',
        field: 'text',
        delta: 'Checking the working tree.',
      });
      const lateDelta = v2.findIndex((e) => e.type === 'item.delta' && e.itemId === 'prt_mock_t2');
      const turnDone = v2.findIndex((e) => e.type === 'turn.completed');
      expect(lateDelta).toBeGreaterThan(-1);
      expect(turnDone).toBeGreaterThan(lateDelta);
      expect(v2[turnDone]).toMatchObject({ type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn' });

      // The real process, not a mock's call log.
      expect(signalsSeen()).toEqual(['SIGTERM']);
      expect(isAlive(pid)).toBe(false);
    } finally {
      session.interrupt();
    }
  }, 30_000);

  it('drives a second turn through sendMessage on the same live server', async () => {
    const { session, pid, v1, v2 } = start();
    try {
      await until(() => v2.some((e) => e.type === 'turn.completed'), 'the first turn to complete');

      expect(session.open).toBe(true);
      expect(session.sendMessage([{ type: 'text', text: 'and again' }])).toBe(true);
      await until(
        () => v2.some((e) => e.type === 'turn.completed' && e.turnId === 'turn_2'),
        'the second turn to complete',
      );

      session.end();
      await session.result;

      expect(v2).toContainEqual({ type: 'turn.started', turnId: 'turn_2' });
      expect(v1.filter((e) => e.type === 'turn-end')).toHaveLength(2);
      expect(session.open).toBe(false);
      // A closed session refuses further input instead of posting to a dead server.
      expect(session.sendMessage([{ type: 'text', text: 'too late' }])).toBe(false);
      expect(isAlive(pid)).toBe(false);
    } finally {
      session.interrupt();
    }
  }, 30_000);

  it('carries the wider bus a real turn produces without leaking foreign or malformed frames', async () => {
    // A canonical `provider/model` id also exercises the model split on the
    // prompt body — the mock answers either way, so nothing here depends on it.
    const { session, pid, v1, v2 } = start({
      env: { MOCK_OPENCODE_RICH_TURN: '1' },
      model: 'anthropic/claude-sonnet-4',
    });
    try {
      await until(() => v2.some((e) => e.type === 'turn.completed'), 'the turn to complete');
      session.end();
      const result = await session.result;

      // The user's own message streams back over the same server-wide feed and
      // must never reach the transcript; a comment keep-alive and a truncated
      // JSON frame must not disturb the stream either.
      expect(result.text).toBe('');
      expect(v1.some((e) => e.type === 'text')).toBe(false);
      expect(v2.some((e) => e.type === 'item.started' && e.item.id === 'prt_user_1')).toBe(false);

      // A reasoning part is v2-only — v1 has no channel for it.
      expect(v2).toContainEqual({ type: 'item.delta', itemId: 'prt_mock_r1', field: 'reasoning', delta: 'The tree may be dirty.' });

      // A tool that ends in `error` reaches v1 as a failed result and v2 as a
      // 'failed' item; its error state carries no input, so the whole state
      // object is what gets reported.
      expect(v1).toContainEqual({ type: 'tool-call', id: 'prt_mock_c9', tool: 'bash', input: { command: 'npm test' } });
      const failed = v1.find((e) => e.type === 'tool-result');
      expect(failed).toMatchObject({ toolCallId: 'prt_mock_c9', isError: true });
      expect(v2.some((e) => e.type === 'item.completed' && e.item.kind === 'tool' && e.item.status === 'failed')).toBe(true);

      expect(v1).toContainEqual({ type: 'token-usage', tokensUsed: 1040 });
      expect(v1.at(-1)).toEqual({ type: 'done' });
      expect(isAlive(pid)).toBe(false);
    } finally {
      session.interrupt();
    }
  }, 30_000);

  it('takes the binary from XEZ_OPENCODE_BIN when no override is given', async () => {
    const previous = process.env.XEZ_OPENCODE_BIN;
    process.env.XEZ_OPENCODE_BIN = mockBin;
    let started: Started | undefined;
    try {
      started = start({ runner: new OpencodeServerRunner({ timeoutMs: 0 }) });
      await until(() => started!.v1.some((e) => e.type === 'session'), 'the session handshake');
      started.session.end();
      await started.session.result;

      // Identity matters here, not just "something answered": a developer with
      // a real `opencode` on PATH must not have that binary satisfy this test.
      // Only the mock mints `ses_mock_1` and only the mock writes the log.
      expect(started.v1[0]).toEqual({ type: 'session', sessionId: 'ses_mock_1' });
      expect(signalsSeen()).toEqual(['SIGTERM']);
      expect(isAlive(started.pid)).toBe(false);
    } finally {
      started?.session.interrupt();
      if (previous === undefined) delete process.env.XEZ_OPENCODE_BIN;
      else process.env.XEZ_OPENCODE_BIN = previous;
    }
  }, 30_000);

  it('ignores a message that carries no text instead of posting an empty prompt', async () => {
    const { session, pid, v1 } = start();
    try {
      await until(() => v1.some((e) => e.type === 'turn-end'), 'the first turn to end');
      const before = v1.filter((e) => e.type === 'turn-end').length;

      expect(session.sendMessage([])).toBe(true);
      await sleep(200);
      expect(v1.filter((e) => e.type === 'turn-end')).toHaveLength(before);

      session.end();
      await session.result;
      expect(isAlive(pid)).toBe(false);
    } finally {
      session.interrupt();
    }
  }, 30_000);

  it('run() completes one turn end-to-end and leaves no server behind', async () => {
    const runner = new OpencodeServerRunner({ bin: mockBin, timeoutMs: 0 });
    const v1: AgentEvent[] = [];
    const result = await runner.run(
      {
        userPrompt: 'check the working tree',
        cwd: process.cwd(),
        env: { MOCK_OPENCODE_SIGNAL_LOG: signalLog },
      },
      (event) => v1.push(event),
    );

    expect(result.text).toContain('Checking the working tree.');
    expect(v1.at(-1)).toEqual({ type: 'done' });
    // `run()` closes itself through the auto-end timer — one SIGTERM, no leak.
    expect(signalsSeen()).toEqual(['SIGTERM']);
  }, 30_000);
});

describe('cancelling a session', () => {
  it('terminates the real child process', async () => {
    const { session, pid, v1 } = start();
    try {
      await until(() => v1.some((e) => e.type === 'text'), 'the first assistant text');
      expect(isAlive(pid)).toBe(true);

      session.interrupt();
      await session.result;

      expect(session.open).toBe(false);
      expect(signalsSeen()).toEqual(['SIGTERM']);
      expect(isAlive(pid)).toBe(false);
    } finally {
      session.interrupt();
    }
  }, 30_000);
});

/**
 * #168 — the prompt used to be POSTed to `/session/:id/message`, which answers
 * only when the whole turn is over. Node's built-in fetch abandons a request
 * whose headers have not arrived in 300s, so every turn longer than five
 * minutes died as `opencode: fetch failed` while it was still working: run
 * `09623ace` made 21 tool calls, the last one 1.1s before the wall, and its
 * SSE feed was still delivering tool results at 300.5s.
 *
 * The mock reproduces that shape under `MOCK_OPENCODE_ASYNC_PROMPT=1`: the
 * blocking route streams the whole turn over the feed and then destroys its own
 * request socket without answering — the same rejection undici produces at
 * 300s, arriving in milliseconds instead. **Nothing here waits 300 seconds.**
 * The same flag serves `POST /session/:id/prompt_async`, the real server's
 * submit-and-return route (verified against opencode 1.18.30: `204` with an
 * empty body in ~10ms, then the turn streaming on the feed and ending with
 * `session.idle`).
 */
describe('a turn that outlives the request that submitted it (#168)', () => {
  const asyncPrompt = { MOCK_OPENCODE_ASYNC_PROMPT: '1' };

  it('completes instead of dying when the blocking request would have been abandoned', async () => {
    const { session, pid, v1, v2 } = start({ env: asyncPrompt });
    try {
      // Either outcome ends the wait, so the failure reads as "an error event
      // arrived", not as a ten-second timeout.
      await until(
        () => v2.some((e) => e.type === 'turn.completed') || v1.some((e) => e.type === 'error'),
        'the turn to end, one way or the other',
      );

      // This is the whole bug: a healthy turn must produce no error at all.
      expect(v1.filter((e) => e.type === 'error')).toEqual([]);

      session.end();
      const result = await session.result;

      // The turn ran to completion over the feed: both text blocks, the tool
      // call and its result, and the usage the HTTP response used to carry.
      expect([...result.text.split('\n')].sort()).toEqual(['Checking the working tree.', 'Done.']);
      expect(v1).toContainEqual({
        type: 'tool-result',
        toolCallId: 'prt_mock_c1',
        result: ' M src/example.ts\n',
        isError: false,
      });
      expect(result.tokensUsed).toBe(1500);
      expect(v1.filter((e) => e.type === 'turn-end')).toHaveLength(1);
      expect(v1.at(-1)).toEqual({ type: 'done' });
      const turnDone = v2.find((e) => e.type === 'turn.completed');
      expect(turnDone).toMatchObject({ type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn' });
      expect(isAlive(pid)).toBe(false);
    } finally {
      session.interrupt();
    }
  }, 30_000);

  /**
   * GUARD — a genuine refusal must still be reported exactly as clearly as it
   * was before. This passes with AND without the fix on purpose: it pins the
   * error path, which the change must not make quieter. It is the async-route
   * twin of 'surfaces the status and body when the prompt POST is rejected'.
   */
  it('GUARD: a refused prompt still names the status and the body', async () => {
    const { session, pid, v1 } = start({ env: { ...asyncPrompt, MOCK_OPENCODE_REJECT_PROMPT: '1' } });
    try {
      await session.result;

      const error = v1.find((e) => e.type === 'error');
      expect(error).toBeDefined();
      expect(error && error.type === 'error' ? error.message : '').toContain('→ 500');
      expect(error && error.type === 'error' ? error.message : '').toContain('no provider configured');
      expect(v1).toContainEqual({ type: 'turn-end' });
      expect(v1.at(-1)).toEqual({ type: 'done' });
      expect(isAlive(pid)).toBe(false);
    } finally {
      session.interrupt();
    }
  }, 30_000);

  /**
   * The one new state this change adds is "submitted, waiting for
   * `session.idle`", and a state needs every exit from it named. `session.idle`
   * is one; the feed ending is the second, and this is it — the server accepts
   * the prompt, streams part of an answer and then drops the SSE socket without
   * ever going idle. The turn must be released by that, not wait forever for an
   * event that can no longer arrive. (The third exit, the server process
   * itself exiting, is covered by 'sends no signal at all when the server
   * already exited on its own'.)
   */
  it('releases the turn when the feed dies without ever going idle', async () => {
    const { session, pid, v1 } = start({ env: { ...asyncPrompt, MOCK_OPENCODE_DROP_STREAM: '1' } });
    try {
      await until(() => v1.some((e) => e.type === 'turn-end'), 'the turn to be released');

      session.end();
      const result = await session.result;

      // Whatever did arrive is kept; nothing hangs.
      expect(result.text).toBe('Partial answer');
      expect(v1.at(-1)).toEqual({ type: 'done' });
      expect(signalsSeen()).toEqual(['SIGTERM']);
      expect(isAlive(pid)).toBe(false);
    } finally {
      session.interrupt();
    }
  }, 30_000);
});

/**
 * #858 — `opencode serve` installs its own SIGTERM handler, so the teardown
 * watchdog must decide "is it dead?" from a real exit, never from
 * `ChildProcess.killed`, which Node flips the moment a signal is *delivered*.
 * Gating on the flag made the SIGKILL unreachable for exactly the server it
 * exists for: one leaked process per teardown, and — because every teardown
 * path is followed by `await this.exited` — a session result that never settles.
 * A real SIGTERM-ignoring child proves both halves at once: the result settles,
 * and the operating system no longer knows the pid.
 */
describe('a server that ignores SIGTERM', () => {
  const ignoreSigterm = { MOCK_OPENCODE_IGNORE_SIGTERM: '1' };

  it('is escalated to SIGKILL after end() and does not leak', async () => {
    const { session, pid, v1 } = start({ env: ignoreSigterm });
    try {
      await until(() => v1.some((e) => e.type === 'session'), 'the session handshake');

      session.end();
      // Handled, not dead: the state that used to disarm the escalation.
      await until(() => signalsSeen().length === 1, 'the SIGTERM to be handled');
      expect(isAlive(pid)).toBe(true);

      const started = Date.now();
      await session.result;
      const elapsed = Date.now() - started;

      expect(signalsSeen()).toEqual(['SIGTERM']);
      expect(isAlive(pid)).toBe(false);
      // It survived the grace window and died to the escalation, not to SIGTERM.
      expect(elapsed).toBeGreaterThanOrEqual(KILL_GRACE_MS - 500);
    } finally {
      session.interrupt();
    }
  }, 30_000);

  it('is escalated on the wall-clock timeout path and reports the timeout', async () => {
    const { session, pid, v1 } = start({ env: ignoreSigterm, timeoutMs: 1_000 });
    try {
      await session.result;

      expect(signalsSeen()).toEqual(['SIGTERM']);
      expect(isAlive(pid)).toBe(false);
      expect(v1.some((e) => e.type === 'error' && e.message.includes('timed out'))).toBe(true);
      expect(v1.at(-1)).toEqual({ type: 'done' });
    } finally {
      session.interrupt();
    }
  }, 30_000);

  it('sends one SIGTERM per session however many teardown paths run', async () => {
    const { session, pid, v1 } = start({ env: ignoreSigterm });
    try {
      await until(() => v1.some((e) => e.type === 'session'), 'the session handshake');

      // interrupt() on cancel and the result promise's finally both reach
      // terminate() for the same session; the escalation is armed once.
      session.interrupt();
      session.end();
      session.interrupt();
      await session.result;

      expect(signalsSeen()).toEqual(['SIGTERM']);
      expect(isAlive(pid)).toBe(false);
    } finally {
      session.interrupt();
    }
  }, 30_000);
});

describe('a server that exits on SIGTERM', () => {
  it('is not escalated — it dies well inside the grace window', async () => {
    const { session, pid, v1 } = start();
    try {
      await until(() => v1.some((e) => e.type === 'session'), 'the session handshake');

      const started = Date.now();
      session.end();
      await session.result;
      const elapsed = Date.now() - started;

      expect(signalsSeen()).toEqual(['SIGTERM']);
      expect(isAlive(pid)).toBe(false);
      expect(elapsed).toBeLessThan(KILL_GRACE_MS);
    } finally {
      session.interrupt();
    }
  }, 30_000);

  it('sends no signal at all when the server already exited on its own', async () => {
    const { session, pid, v2 } = start({ env: { MOCK_OPENCODE_EXIT_AFTER_IDLE: '1' } });
    try {
      // The mock shuts itself down after `session.idle`; the runner's result
      // settles on that exit, and its teardown must find nothing to signal.
      await session.result;

      expect(v2).toContainEqual({ type: 'turn.started', turnId: 'turn_1' });
      expect(signalsSeen()).toEqual([]);
      expect(isAlive(pid)).toBe(false);
    } finally {
      session.interrupt();
    }
  }, 30_000);
});

describe('a server that fails before or during the stream', () => {
  it('surfaces a handled session error when it exits before the handshake', async () => {
    const { session, pid, v1 } = start({ env: { MOCK_OPENCODE_EXIT_BEFORE_LISTEN: '1' } });
    try {
      // A rejection, not an unhandled one: the session settles normally.
      const result = await session.result;

      expect(v1).toContainEqual({
        type: 'error',
        message: 'opencode: opencode serve exited before it started listening',
      });
      expect(v1.at(-1)).toEqual({ type: 'done' });
      expect(result.text).toBe('');
      expect(v1.some((e) => e.type === 'session')).toBe(false);
      expect(isAlive(pid)).toBe(false);
    } finally {
      session.interrupt();
    }
  }, 30_000);

  it('reports a create response that names no session instead of prompting blind', async () => {
    const { session, pid, v1 } = start({ env: { MOCK_OPENCODE_NO_SESSION_ID: '1' } });
    try {
      await session.result;

      expect(v1).toContainEqual({ type: 'error', message: 'opencode: opencode did not return a session id' });
      expect(v1.some((e) => e.type === 'session')).toBe(false);
      expect(v1.at(-1)).toEqual({ type: 'done' });
      expect(signalsSeen()).toEqual(['SIGTERM']);
      expect(isAlive(pid)).toBe(false);
    } finally {
      session.interrupt();
    }
  }, 30_000);

  it('surfaces the status and body when the prompt POST is rejected', async () => {
    const { session, pid, v1 } = start({ env: { MOCK_OPENCODE_REJECT_PROMPT: '1' } });
    try {
      await session.result;

      const error = v1.find((e) => e.type === 'error');
      expect(error).toBeDefined();
      expect(error && error.type === 'error' ? error.message : '').toContain('→ 500');
      expect(error && error.type === 'error' ? error.message : '').toContain('no provider configured');
      // The failed turn still closes its v1 boundary before the session ends.
      expect(v1).toContainEqual({ type: 'turn-end' });
      expect(v1.at(-1)).toEqual({ type: 'done' });
      expect(isAlive(pid)).toBe(false);
    } finally {
      session.interrupt();
    }
  }, 30_000);

  it('ends the turn with the documented error stop reason when the transport drops mid-stream', async () => {
    const { session, pid, v1, v2 } = start({ env: { MOCK_OPENCODE_DROP_STREAM: '1' } });
    try {
      await until(() => v2.some((e) => e.type === 'turn.completed'), 'the turn to complete');

      expect(v2).toContainEqual({
        type: 'session.error',
        message: 'connection closed mid-stream',
        fatal: false,
      });
      expect(v2).toContainEqual({ type: 'turn.completed', turnId: 'turn_1', stopReason: 'error' });

      // The SSE socket then goes away mid-stream; the session still closes down
      // cleanly and the server is reaped.
      await sleep(120);
      session.end();
      await session.result;

      expect(v1.at(-1)).toEqual({ type: 'done' });
      expect(signalsSeen()).toEqual(['SIGTERM']);
      expect(isAlive(pid)).toBe(false);
    } finally {
      session.interrupt();
    }
  }, 30_000);

  /**
   * Current behaviour, pinned rather than fixed (no production change in #55).
   * A missing binary makes `spawn` emit ENOENT immediately, but the runner only
   * learns about it through `waitForServerUrl`, which listens for stdout or an
   * `exit` event — an ENOENT spawn emits `error` and `close`, never `exit`. So
   * the handshake sits on its full SERVER_START_TIMEOUT_MS (30s) window before
   * the wrapped "install OpenCode" hint reaches the caller, where the claude
   * and codex runners report the same mistake at once. Asserting the wait here
   * would cost the suite 30 seconds, so the test pins the shape: still pending
   * a second and a half in, and nothing spawned that could leak.
   */
  it('does not surface a missing binary until the server-start window elapses', async () => {
    const runner = new OpencodeServerRunner({ bin: join(tmpDir, 'no-such-opencode') });
    const session = runner.startSession({ userPrompt: 'do it', cwd: process.cwd() });
    // The eventual rejection is the documented outcome; nothing must treat it
    // as unhandled while this test measures the delay.
    const outcome = session.result.then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

    expect(session.pid).toBeUndefined();
    await expect(Promise.race([outcome, sleep(1_500).then(() => 'still pending')])).resolves.toBe(
      'still pending',
    );
  }, 30_000);
});
