import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent, AgentRunResult } from './agent-runner.js';
import type { UiEvent } from './ui-events.js';
import { buildChildEnv } from './agent-env.js';
import { detectEnvironment } from './backend-detect.js';
import { createRunner } from './runner-factory.js';
import { buildPiArgs, PiRunner } from './pi-runner.js';

/** Only the coalescing tests below swap the child out; every other test in
 *  this file keeps spawning the real mock CLI through the untouched `spawn`. */
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
