import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent, AgentRunResult } from './agent-runner.js';
import type { UiEvent } from './ui-events.js';
import { buildChildEnv } from './agent-env.js';
import { detectEnvironment } from './backend-detect.js';
import { createRunner } from './runner-factory.js';
import { buildPiArgs, KILL_GRACE_MS, PiRunner } from './pi-runner.js';

/** Only the escalation (#D), text-coalescing (#151) and signal-termination (#156) tests below
 *  swap the child out; every other test in this file keeps spawning its real stub binary
 *  through the untouched `spawn`. Mirrors the identical hook in `claude-cli-runner.test.ts`. */
const spawnHook = vi.hoisted(() => ({ override: null as null | (() => unknown) }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnHook.override ? spawnHook.override() : actual.spawn(...args),
  };
});

/**
 * The `pi` runner (#387): a new AgentBackend slotted into the runner seam as
 * ONE class. These lock the three seam-level guarantees the issue asks for —
 * the factory hands back a pi runner, detection degrades gracefully when the
 * pi CLI is absent, and the documented RPC protocol emits the normalized
 * streams every backend shares.
 */

describe('createRunner returns the pi runner', () => {
  it('maps the "pi" id to a PiRunner with backend "pi"', () => {
    const runner = createRunner('pi');
    expect(runner).toBeInstanceOf(PiRunner);
    expect(runner.backend).toBe('pi');
  });
});

describe('backend-detect handles an absent pi CLI', () => {
  const saved = { bin: process.env.XEZ_PI_BIN, dry: process.env.XEZ_DRY_RUN };

  beforeEach(() => {
    delete process.env.XEZ_DRY_RUN; // real probe, not the mock short-circuit
    process.env.XEZ_PI_BIN = join(tmpdir(), 'xez-pi-does-not-exist-xyz');
  });
  afterEach(() => {
    if (saved.bin === undefined) delete process.env.XEZ_PI_BIN;
    else process.env.XEZ_PI_BIN = saved.bin;
    if (saved.dry === undefined) delete process.env.XEZ_DRY_RUN;
    else process.env.XEZ_DRY_RUN = saved.dry;
  });

  it('reports pi as unavailable with a hint, and never rejects (no boot failure)', async () => {
    const checks = await detectEnvironment();
    const pi = checks.find((c) => c.name === 'pi');
    expect(pi).toBeDefined();
    expect(pi!.available).toBe(false);
    expect(pi!.hint).toContain('pi');
  });
});

describe('a dry-run pi session emits normalized AgentEvents', () => {
  const saved = process.env.XEZ_DRY_RUN;
  let cwd: string;

  beforeEach(() => {
    process.env.XEZ_DRY_RUN = '1'; // swap in the shared mock CLI
    cwd = mkdtempSync(join(tmpdir(), 'xez-pi-run-'));
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.XEZ_DRY_RUN;
    else process.env.XEZ_DRY_RUN = saved;
    rmSync(cwd, { recursive: true, force: true });
  });

  it('streams text, a tool call/result and a terminal done over the mock', async () => {
    const runner = new PiRunner();
    expect(runner.backend).toBe('pi');

    const events: AgentEvent[] = [];
    const result = await runner.run(
      { userPrompt: 'investigate the login redirect bug', cwd, timeoutMs: 20_000 },
      (event) => events.push(event),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain('text');
    expect(types).toContain('tool-call');
    expect(types).toContain('tool-result');
    // Every backend's stream is terminated by exactly one `done`.
    expect(types.filter((t) => t === 'done')).toHaveLength(1);
    expect(result.text.length).toBeGreaterThan(0);
  });
});

/**
 * #156 / #703 backend parity — pi tracked no "we sent the signal" bit at all,
 * so its own teardown surfaced as `pi CLI exited with code 143` (a failure),
 * and an outside kill surfaced as the same sentence. Both halves now have to
 * say which one happened, exactly as the claude and codex runners do.
 */
describe('pi signal terminations', () => {
  /** A child that exits on command — nothing here signals a real process. */
  function startWithFakeChild(): {
    signals: NodeJS.Signals[];
    exit: (code: number) => void;
    events: AgentEvent[];
    session: ReturnType<PiRunner['startSession']>;
  } {
    const signals: NodeJS.Signals[] = [];
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      pid: 4246,
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal);
        Object.assign(child, { killed: true });
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    const exit = (code: number) => {
      Object.assign(child, { exitCode: code });
      stdout.end(); // the CLI's stdout closes as it dies — ends the read loop
      emitter.emit('exit', code, null);
      emitter.emit('close', code, null);
    };
    spawnHook.override = () => child;
    try {
      const events: AgentEvent[] = [];
      const session = new PiRunner({ bin: 'pi', timeoutMs: 0 }).startSession(
        { userPrompt: 'do it', cwd: process.cwd() },
        (event) => events.push(event),
      );
      return { signals, exit, events, session };
    } finally {
      spawnHook.override = null;
    }
  }

  it('names the signal and says xezar did not send it', async () => {
    const { signals, exit, events, session } = startWithFakeChild();

    exit(143); // injected, never signalled — the #156 shape

    await expect(session.result).rejects.toThrow(
      /pi CLI was terminated by SIGTERM \(exit 143\) — xezar sent no signal/,
    );
    expect(signals).toEqual([]);
    const error = events.find((event) => event.type === 'error');
    expect(error?.type === 'error' && error.message).toContain('#156');
  }, 15_000);

  /** GUARD — a teardown xezar asked for stays an intentional stop (#703) and
   *  must never pick up the "xezar sent no signal" wording. */
  it('reports a xezar-initiated teardown as a teardown, not a failure', async () => {
    const { signals, exit, events, session } = startWithFakeChild();

    session.interrupt();
    expect(signals).toEqual(['SIGTERM']);
    exit(143);

    await session.result;
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(
      events.some(
        (event) => event.type === 'note' && event.message.includes('terminated by xezar (code 143)'),
      ),
    ).toBe(true);
    expect(
      events.some((event) => event.type === 'note' && event.message.includes('xezar sent no signal')),
    ).toBe(false);
  }, 15_000);
});

describe('pi RPC argv', () => {
  it('uses pi RPC mode, exact session selection, provider/model, and pi tool names', () => {
    expect(
      buildPiArgs({
        cwd: '/repo',
        userPrompt: 'task',
        sessionId: 'session-1',
        resume: true,
        model: 'openai/gpt-5.1',
        systemPrompt: 'Keep changes focused.',
        allowedTools: ['Read', 'Bash', 'Edit', 'Write', 'Grep', 'Glob'],
      }),
    ).toEqual([
      '--mode',
      'rpc',
      '--session',
      'session-1',
      '--append-system-prompt',
      'Keep changes focused.',
      '--model',
      'openai/gpt-5.1',
      '--tools',
      'read,bash,edit,write,grep,find',
    ]);
  });

  it('creates a new exact session id instead of invoking the interactive resume picker', () => {
    expect(buildPiArgs({ cwd: '/repo', userPrompt: 'task', sessionId: 'session-1' })).toEqual([
      '--mode',
      'rpc',
      '--session-id',
      'session-1',
    ]);
  });

  it('fails closed by disabling bash when a command-prefix allowlist cannot be represented', () => {
    expect(
      buildPiArgs({
        cwd: '/repo',
        userPrompt: 'task',
        allowedTools: ['Read', 'Bash'],
        bashAllowlist: ['npm test'],
      }),
    ).toEqual(['--mode', 'rpc', '--tools', 'read']);
  });
});

describe('pi spawns under pi credentials, not another runner', () => {
  const source: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'ant',
    OPENAI_API_KEY: 'oai',
    OPENROUTER_API_KEY: 'orr',
    SOME_UNRELATED_SECRET: 'nope',
  };

  it('gives pi the multi-provider set a provider/model id can name', () => {
    const env = buildChildEnv({ backend: 'pi', source });
    expect(env.ANTHROPIC_API_KEY).toBe('ant');
    expect(env.OPENAI_API_KEY).toBe('oai');
    expect(env.OPENROUTER_API_KEY).toBe('orr');
  });

  it('still withholds everything outside the allowlist — pi is not a full-env escape hatch', () => {
    expect(buildChildEnv({ backend: 'pi', source }).SOME_UNRELATED_SECRET).toBeUndefined();
  });

  it('leaves claude Anthropic-only — widening pi must not widen claude', () => {
    const env = buildChildEnv({ backend: 'claude', source });
    expect(env.ANTHROPIC_API_KEY).toBe('ant');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('never inherits Claude Code’s cloud credentials — pi does not read its toggles', () => {
    // `CLAUDE_CODE_USE_BEDROCK` / `_USE_VERTEX` unlock the AWS/GCP credential families for the
    // backend that is given the `CLAUDE_` prefix to read them. pi is not Claude Code and reads
    // neither toggle, so a host that configured Claude Code for Bedrock must not thereby hand a
    // pi process its cloud keys. OpenCode — the same `provider/model` shape — is the control.
    const cloudSource: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CONFIG_DIR: '/home/u/.claude',
      AWS_ACCESS_KEY_ID: 'akid',
      AWS_SECRET_ACCESS_KEY: 'asak',
      GOOGLE_APPLICATION_CREDENTIALS: '/home/u/gcp.json',
      GOOGLE_CLOUD_PROJECT: 'proj',
    };
    for (const backend of ['pi', 'opencode'] as const) {
      const env = buildChildEnv({ backend, source: cloudSource });
      expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
      expect(env.GOOGLE_CLOUD_PROJECT).toBeUndefined();
      expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    }
    // …and claude still gets exactly what the toggles exist to deliver.
    expect(buildChildEnv({ backend: 'claude', source: cloudSource }).AWS_ACCESS_KEY_ID).toBe('akid');
  });

  it('keeps the seam identity pi-specific', () => {
    expect(new PiRunner().backend).toBe('pi');
  });
});

/** #151 — pi streams text as deltas and emits one v1 `text` per delta, which
 *  splits turn-end markers across events (appendTurnText joins events with a
 *  newline, so a split marker is no longer contiguous and never parses). The
 *  fix coalesces per completed message like codex and opencode. */
describe('pi v1 text coalescing (claude parity, #151)', () => {
  const fixture = readFileSync(
    fileURLToPath(new URL('./__fixtures__/pi/v1-text-coalescing.ndjson', import.meta.url)),
    'utf8',
  );

  afterEach(() => {
    spawnHook.override = null;
  });

  /** A fake child the runner reads NDJSON from. Writes buffer, then `finish`
   *  ends stdout and reports the exit code so the runner settles normally. */
  function fakePiChild(): {
    child: import('node:child_process').ChildProcessWithoutNullStreams;
    write: (line: string) => void;
    finish: (code: number) => void;
  } {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin,
      stdout,
      stderr,
      pid: 9876,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      kill: () => {
        Object.assign(child, { killed: true });
        return true;
      },
    }) as unknown as import('node:child_process').ChildProcessWithoutNullStreams;
    return {
      child,
      write: (line: string) => stdout.write(`${line}\n`),
      finish: (code: number) => {
        Object.assign(child, { exitCode: code });
        stdout.end();
        emitter.emit('close', code, null);
      },
    };
  }

  function feedStream(lines: string[], uiEvents?: UiEvent[]): {
    events: AgentEvent[];
    result: Promise<AgentRunResult>;
  } {
    const fake = fakePiChild();
    spawnHook.override = () => fake.child;
    const events: AgentEvent[] = [];
    const session = new PiRunner({ bin: 'pi', timeoutMs: 20_000 }).startSession(
      { userPrompt: 'do the thing', cwd: process.cwd() },
      (event) => events.push(event),
      uiEvents ? { onUiEvent: (e) => uiEvents.push(e) } : undefined,
    );
    for (const line of lines) fake.write(line);
    fake.finish(0);
    return { events, result: session.result };
  }

  it('emits ONE v1 text event per completed message, never per delta', async () => {
    const { events, result } = feedStream(fixture.trim().split('\n').filter(Boolean));
    await result;
    const texts = events.filter((e) => e.type === 'text');
    expect(texts).toEqual([
      { type: 'text', text: 'Checking the working tree.' },
      { type: 'text', text: 'All gates passed.' },
    ]);
  });

  it('keeps the done marker contiguous when the delta stream splits it', async () => {
    // The done marker is built at runtime so this source never contains the
    // parseable literal (the parser would otherwise read it as a real emission).
    const DONE = 'X-E-Z'.replaceAll('-', '') + ':DONE';
    const { events, result } = feedStream([
      JSON.stringify({ id: 's', type: 'response', command: 'get_state', success: true, data: { sessionId: 's1' } }),
      JSON.stringify({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} } }),
      JSON.stringify({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' tree is clean.\n\n' + DONE.slice(0, 3) } }),
      JSON.stringify({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: DONE.slice(3) } }),
      JSON.stringify({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: ' tree is clean.\n\n' + DONE, partial: {} } }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } }),
      JSON.stringify({ type: 'agent_settled' }),
    ]);
    await result;
    const texts = events.filter((e) => e.type === 'text');
    // One coalesced event carries the whole marker, so the parser sees it intact.
    expect(texts).toHaveLength(1);
    const textEvent = texts[0] as Extract<AgentEvent, { type: 'text' }>;
    expect(textEvent.text).toBe(' tree is clean.\n\n' + DONE);
    // The done-marker regex (built at runtime) matches the assembled turn text.
    const doneRe = new RegExp('X-E-Z'.replaceAll('-', '') + ':DONE\\s*$');
    expect(doneRe.test(textEvent.text.trimEnd())).toBe(true);
  });

  /** A chunk is a whole message now, not a delta, so the result text has to
   *  separate them the way claude, codex and opencode all do. Concatenating
   *  would run two messages together ("…first message.Second message."). */
  it('joins whole messages with a newline in the result text, like the other runners', async () => {
    const { result } = feedStream(fixture.trim().split('\n').filter(Boolean));
    const run = await result;
    expect(run.text).toBe('Checking the working tree.\nAll gates passed.');
  });

  /** The coalescer only drains on `complete`/`flush`. pi's read loop can end
   *  with neither: `interrupt()` (the timeout path) writes `{type:'abort'}` and
   *  SIGTERMs at once, so stdout ends with no `message_end` and no
   *  `agent_settled` — the case the runner itself notes as "pi RPC session
   *  ended before agent_settled". Without a flush after the loop the buffered
   *  prose is dropped, which is prose a pre-coalescing pi run used to keep. */
  it('keeps buffered prose when the stream ends before message_end and agent_settled', async () => {
    const { events, result } = feedStream([
      JSON.stringify({ id: 's', type: 'response', command: 'get_state', success: true, data: { sessionId: 's1' } }),
      JSON.stringify({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} } }),
      JSON.stringify({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Partial prose ' } }),
      JSON.stringify({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'before the kill.' } }),
      // …and then the process dies: no text_end, no message_end, no agent_settled.
    ]);
    const run = await result;
    const texts = events.filter((e) => e.type === 'text');
    expect(texts).toEqual([{ type: 'text', text: 'Partial prose before the kill.' }]);
    expect(run.text).toBe('Partial prose before the kill.');
  });

  /** GUARD: the post-loop flush must not re-emit text a `message_end` already
   *  completed. `complete()` deletes the pending bucket, so a later `flush()`
   *  finds nothing — this pins that and passes both with and without the fix. */
  it('GUARD: a normally completed turn emits its text exactly once, never twice', async () => {
    const { events, result } = feedStream([
      JSON.stringify({ id: 's', type: 'response', command: 'get_state', success: true, data: { sessionId: 's1' } }),
      JSON.stringify({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} } }),
      JSON.stringify({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Settled ' } }),
      JSON.stringify({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'prose.' } }),
      JSON.stringify({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Settled prose.', partial: {} } }),
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Settled prose.' }], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } },
      }),
      JSON.stringify({ type: 'agent_settled' }),
    ]);
    const run = await result;
    const texts = events.filter((e) => e.type === 'text');
    expect(texts).toEqual([{ type: 'text', text: 'Settled prose.' }]);
    expect(run.text).toBe('Settled prose.');
  });

  it('GUARD: the v2 item.delta stream still emits per delta, not coalesced', async () => {
    const uiEvents: UiEvent[] = [];
    const { result } = feedStream(
      [
        JSON.stringify({ id: 's', type: 'response', command: 'get_state', success: true, data: { sessionId: 's1' } }),
        JSON.stringify({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} } }),
        JSON.stringify({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello ' } }),
        JSON.stringify({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'world' } }),
        JSON.stringify({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Hello world', partial: {} } }),
        JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } }),
        JSON.stringify({ type: 'agent_settled' }),
      ],
      uiEvents,
    );
    await result;
    const deltas = uiEvents.filter((e) => e.type === 'item.delta' && e.field === 'text');
    expect(deltas.map((d) => (d as Extract<UiEvent, { type: 'item.delta' }>).delta)).toEqual([
      'Hello ',
      'world',
    ]);
  });
});

/**
 * D — backend parity at the timeout seam (AGENT_PROTOCOL.md §AgentSession).
 *
 * pi honoured `spec.timeoutMs` from the start, but on expiry it only called `interrupt()`:
 * one RPC abort and one SIGTERM. It declared `KILL_GRACE_MS` and never used it on the
 * timeout path, so a pi that installs its own SIGTERM handler (or is wedged) was NEVER
 * force-killed — `timeout:` was enforced for claude/codex/opencode and advisory for pi.
 *
 * The liveness question is `trackChildExit`, never `child.killed`/`child.exitCode == null`:
 * Node flips `killed` the moment a signal is DELIVERED, so a CLI that handles SIGTERM keeps
 * running with the flag already true, and an escalation gated on it never fires (#844).
 */
describe('pi wall-clock timeout escalates SIGTERM -> SIGKILL (D)', () => {
  function signallableChild(): {
    child: ChildProcessWithoutNullStreams;
    signals: NodeJS.Signals[];
    exit: (code: number) => void;
  } {
    const signals: NodeJS.Signals[] = [];
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      pid: 5150,
      // Node's semantics: delivery flips `killed`; a CLI with its own handler keeps running
      // with `exitCode` still null.
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal);
        Object.assign(child, { killed: true });
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    const exit = (code: number) => {
      Object.assign(child, { exitCode: code });
      emitter.emit('exit', code, null);
    };
    return { child, signals, exit };
  }

  function withFakeChild(run: (fake: ReturnType<typeof signallableChild>) => void): void {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    vi.useFakeTimers();
    try {
      run(fake);
    } finally {
      vi.useRealTimers();
      spawnHook.override = null;
    }
  }

  it('force-kills a pi that survives the SIGTERM its timeout sent', () => {
    withFakeChild((fake) => {
      const session = new PiRunner({ bin: 'pi', timeoutMs: 20 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      vi.advanceTimersByTime(20);
      expect(fake.signals).toEqual(['SIGTERM']);
      // Delivered, not dead — the state that used to disable every escalation (#844).
      expect(fake.child.killed).toBe(true);
      expect(fake.child.exitCode).toBeNull();

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('stops escalating once pi really exits after the SIGTERM', () => {
    withFakeChild((fake) => {
      const session = new PiRunner({ bin: 'pi', timeoutMs: 20 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      vi.advanceTimersByTime(20);
      expect(fake.signals).toEqual(['SIGTERM']);
      fake.exit(143);

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
    });
  });

  it('still signals when the session had already auto-ended (the `open` guard)', () => {
    // `autoEndAfterFirstTurn` sets `open = false`; the old `interrupt()` returned early on
    // that, so the deadline fired into a no-op and nothing was ever killed.
    withFakeChild((fake) => {
      const session = new PiRunner({ bin: 'pi', timeoutMs: 20 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);
      session.end();
      fake.signals.length = 0;

      vi.advanceTimersByTime(20);
      expect(fake.signals).toContain('SIGTERM');
      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toContain('SIGKILL');
    });
  });

  it('arms no wall clock at all when the step disabled it (timeoutMs: 0)', () => {
    withFakeChild((fake) => {
      const session = new PiRunner({ bin: 'pi', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      vi.advanceTimersByTime(60 * 60_000);
      expect(fake.signals).toEqual([]);
    });
  });
});
