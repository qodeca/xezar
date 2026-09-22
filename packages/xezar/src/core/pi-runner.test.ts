import { spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
import {
  buildPiArgs,
  KILL_GRACE_MS,
  PiRunner,
  type PiMcpConfigAnswer,
  type PiMcpConfigProbe,
} from './pi-runner.js';

/** Only the escalation (#D), text-coalescing (#151) and signal-termination (#156) tests below
 *  swap the child out; every other test in this file keeps spawning its real stub binary
 *  through the untouched `spawn`. Mirrors the identical hook in `claude-cli-runner.test.ts`. */
const spawnHook = vi.hoisted(() => ({
  override: null as null | (() => unknown),
  onSpawn: null as null | (() => void),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (!spawnHook.override) return actual.spawn(...args);
      const child = spawnHook.override();
      spawnHook.onSpawn?.();
      return child;
    },
  };
});

/** The runner asks the binary a capability question before it spawns (#548), so the child exists
 *  one microtask turn after `startSession` returns; these tests wait for the spawn itself rather
 *  than for a guessed number of turns. The probe is injected so it never reaches a real `pi`. */
const NO_MCP_CONFIG: PiMcpConfigProbe = async () => 'no';
function whenSpawned(): Promise<void> {
  return new Promise<void>((resolve) => {
    spawnHook.onSpawn = () => {
      spawnHook.onSpawn = null;
      resolve();
    };
  });
}

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
  async function startWithFakeChild(): Promise<{
    signals: NodeJS.Signals[];
    exit: (code: number) => void;
    events: AgentEvent[];
    session: ReturnType<PiRunner['startSession']>;
  }> {
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
    const spawned = whenSpawned();
    try {
      const events: AgentEvent[] = [];
      const session = new PiRunner({ bin: 'pi', timeoutMs: 0, supportsMcpConfig: NO_MCP_CONFIG }).startSession(
        { userPrompt: 'do it', cwd: process.cwd() },
        (event) => events.push(event),
      );
      await spawned;
      return { signals, exit, events, session };
    } finally {
      spawnHook.override = null;
    }
  }

  it('names the signal and says xezar did not send it', async () => {
    const { signals, exit, events, session } = await startWithFakeChild();

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
    const { signals, exit, events, session } = await startWithFakeChild();

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
  it('uses pi RPC mode, exact session selection, provider/model, pi tool names, and pins an isolated tool root', () => {
    expect(
      buildPiArgs({
        cwd: '/repo/.local/xezar/worktrees/task',
        userPrompt: 'task',
        sessionId: 'session-1',
        resume: true,
        model: 'openai/gpt-5.1',
        systemPrompt: 'Keep changes focused.',
        worktreeRoot: '/repo/.local/xezar/worktrees/task',
        primaryRoot: '/repo',
        additionalDirectories: ['/repo/.local/xezar/runs', '/repo/.local/xezar/tmp/task'],
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
      '--extension',
      expect.stringMatching(/scripts\/pi-worktree-guard\.ts$/),
      // `--flag=value` keeps a root that starts with `-` or `@` from being read as a boolean flag.
      '--xezar-worktree-root=/repo/.local/xezar/worktrees/task',
      '--xezar-primary-root=/repo',
      '--xezar-allowed-roots=["/repo/.local/xezar/runs","/repo/.local/xezar/tmp/task"]',
      // no bashAllowlist key: the guard is told so, and a missing flag would refuse bash (#856)
      '--xezar-bash-allowlist=null',
    ]);
  });

  it('does not add the worktree guard for an in-place or non-git run', () => {
    const args = buildPiArgs({ cwd: '/repo', userPrompt: 'task', additionalDirectories: ['/repo/.local/xezar/runs'] });
    expect(args).not.toContain('--extension');
    expect(args.some((arg) => arg.startsWith('--xezar-'))).toBe(false);
  });

  it('creates a new exact session id instead of invoking the interactive resume picker', () => {
    expect(buildPiArgs({ cwd: '/repo', userPrompt: 'task', sessionId: 'session-1' })).toEqual([
      '--mode',
      'rpc',
      '--session-id',
      'session-1',
    ]);
  });

  it('maps the read-only code-review list onto pi tools with no edit or write (#849)', () => {
    expect(
      buildPiArgs({ cwd: '/repo', userPrompt: 'task', allowedTools: ['Read', 'Grep', 'Glob', 'Bash'] }),
    ).toEqual(['--mode', 'rpc', '--tools', 'read,grep,find,bash']);
  });

  it('keeps bash and hands a bashAllowlist to the guard extension, with no worktree (#856)', () => {
    const args = buildPiArgs({
      cwd: '/repo',
      userPrompt: 'task',
      allowedTools: ['Read', 'Bash'],
      bashAllowlist: [' npm test ', '', 'gh pr comment'],
    });
    expect(args.slice(0, 4)).toEqual(['--mode', 'rpc', '--tools', 'read,bash']);
    expect(args[4]).toBe('--extension');
    expect(args[5]).toMatch(/pi-worktree-guard\.ts$/);
    expect(args.slice(6)).toEqual(['--xezar-bash-allowlist=["npm test","gh pr comment"]']);
  });

  it('adds the bashAllowlist flag after the worktree flags on a worktree run (#856)', () => {
    const args = buildPiArgs({
      cwd: '/wt',
      userPrompt: 'task',
      allowedTools: ['Bash'],
      bashAllowlist: ['git diff'],
      worktreeRoot: '/wt',
      primaryRoot: '/repo',
    });
    expect(args.filter((arg) => arg === '--extension')).toHaveLength(1);
    expect(args.slice(-3)).toEqual(['--xezar-worktree-root=/wt', '--xezar-primary-root=/repo', '--xezar-bash-allowlist=["git diff"]']);
  });

  // Fable's table on #861, round 2: `[]` and a blanks-only list are the same list – no entry – so
  // both remove bash and both still hand the guard `[]`, which refuses every bash command.
  it.each([
    ['[]', []],
    ['["  ", ""]', ['  ', '']],
  ])('removes bash and passes `[]` for the list %s, with no worktree', (_name, bashAllowlist) => {
    const args = buildPiArgs({ cwd: '/repo', userPrompt: 'task', allowedTools: ['Read', 'Bash'], bashAllowlist });
    expect(args.slice(0, 4)).toEqual(['--mode', 'rpc', '--tools', 'read']);
    expect(args[4]).toBe('--extension');
    expect(args[5]).toMatch(/pi-worktree-guard\.ts$/);
    expect(args.slice(6)).toEqual(['--xezar-bash-allowlist=[]']);
  });

  it.each([
    ['[]', []],
    ['["  ", ""]', ['  ', '']],
  ])('removes bash and passes `[]` for the list %s on a worktree run', (_name, bashAllowlist) => {
    const args = buildPiArgs({
      cwd: '/wt',
      userPrompt: 'task',
      allowedTools: ['Read', 'Bash'],
      bashAllowlist,
      worktreeRoot: '/wt',
      primaryRoot: '/repo',
    });
    expect(args.slice(2, 4)).toEqual(['--tools', 'read']);
    expect(args.slice(-3)).toEqual(['--xezar-worktree-root=/wt', '--xezar-primary-root=/repo', '--xezar-bash-allowlist=[]']);
  });

  it('leaves the in-place argv unchanged without a bashAllowlist key (#856 C)', () => {
    expect(buildPiArgs({ cwd: '/repo', userPrompt: 'task', allowedTools: ['Read', 'Bash'] })).toEqual(['--mode', 'rpc', '--tools', 'read,bash']);
  });

  // The dry-run mock refuses an option it does not know, as the real CLI does (#548), so every
  // flag `buildPiArgs` can emit must parse there – a worktree dry run carries the allowlist flag.
  it.each([
    ['without a bashAllowlist key', undefined],
    ['with a bashAllowlist', ['git diff']],
    ['with an empty bashAllowlist', []],
  ])('emits an argv the dry-run mock accepts on a worktree run %s', (_name, bashAllowlist) => {
    const args = buildPiArgs({ cwd: '/wt', userPrompt: 'task', allowedTools: ['Bash'], bashAllowlist, worktreeRoot: '/wt', primaryRoot: '/repo', additionalDirectories: ['/runs'] });
    const mock = fileURLToPath(new URL('../../scripts/mock-pi-rpc.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [mock, ...args], { input: '', encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('tells the guard `null` – no allowlist – on a worktree run without a bashAllowlist key', () => {
    const args = buildPiArgs({ cwd: '/wt', userPrompt: 'task', allowedTools: ['Bash'], worktreeRoot: '/wt', primaryRoot: '/repo' });
    expect(args.slice(2, 4)).toEqual(['--tools', 'bash']);
    expect(args.at(-1)).toBe('--xezar-bash-allowlist=null');
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

  async function feedStream(lines: string[], uiEvents?: UiEvent[]): Promise<{
    events: AgentEvent[];
    result: Promise<AgentRunResult>;
  }> {
    const fake = fakePiChild();
    spawnHook.override = () => fake.child;
    const spawned = whenSpawned();
    const events: AgentEvent[] = [];
    const session = new PiRunner({ bin: 'pi', timeoutMs: 20_000, supportsMcpConfig: NO_MCP_CONFIG }).startSession(
      { userPrompt: 'do the thing', cwd: process.cwd() },
      (event) => events.push(event),
      uiEvents ? { onUiEvent: (e) => uiEvents.push(e) } : undefined,
    );
    await spawned;
    for (const line of lines) fake.write(line);
    fake.finish(0);
    return { events, result: session.result };
  }

  it('emits ONE v1 text event per completed message, never per delta', async () => {
    const { events, result } = await feedStream(fixture.trim().split('\n').filter(Boolean));
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
    const { events, result } = await feedStream([
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
    const { result } = await feedStream(fixture.trim().split('\n').filter(Boolean));
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
    const { events, result } = await feedStream([
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
    const { events, result } = await feedStream([
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
    const { result } = await feedStream(
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
/**
 * #369: a pi extension dialog (`extension_ui_request` with a dialog method) BLOCKS pi until
 * the client answers it on pi's own sub-protocol, and pi-mcp-adapter's `approveTools` gate
 * emits one with no `timeout`. The runner used to ignore the frame, so a gated tool held the
 * turn open for ever. The wire-faithful frame below is the one the A-01 harness recorded.
 */
describe('pi extension dialogs reach the cockpit and are answered on the wire (#369)', () => {
  const APPROVAL_DIALOG = JSON.stringify({
    type: 'extension_ui_request',
    id: 'dlg-1',
    method: 'select',
    title: 'MCP: xezar wants to run health\n\nArguments:\n{}',
    options: ['Allow once', 'Allow for session', 'Deny'],
  });

  afterEach(() => {
    spawnHook.override = null;
  });

  /** A fake pi whose stdin is captured, so what the runner wrote back is assertable. */
  function scriptedPi(): {
    child: ChildProcessWithoutNullStreams;
    write: (line: string) => void;
    finish: (code: number) => void;
    /** Every frame the runner wrote to pi, parsed. */
    written: () => Array<Record<string, unknown>>;
  } {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let captured = '';
    stdin.on('data', (chunk: Buffer | string) => {
      captured += chunk.toString();
    });
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin,
      stdout,
      stderr,
      pid: 4242,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      kill: () => {
        Object.assign(child, { killed: true });
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    return {
      child,
      write: (line: string) => stdout.write(`${line}\n`),
      finish: (code: number) => {
        Object.assign(child, { exitCode: code });
        stdout.end();
        emitter.emit('close', code, null);
      },
      written: () => captured.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
    };
  }

  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('raises the dialog as an ask card and routes the answer back as extension_ui_response', async () => {
    const fake = scriptedPi();
    spawnHook.override = () => fake.child;
    const spawned = whenSpawned();
    const events: AgentEvent[] = [];
    const uiEvents: UiEvent[] = [];
    const session = new PiRunner({ bin: 'pi', timeoutMs: 20_000, supportsMcpConfig: NO_MCP_CONFIG }).startSession(
      { userPrompt: 'CALL health', cwd: process.cwd() },
      (event) => events.push(event),
      { onUiEvent: (event) => uiEvents.push(event) },
    );
    await spawned;
    fake.write(APPROVAL_DIALOG);
    await tick();

    const ask = uiEvents.find((event) => event.type === 'ask.requested');
    expect(ask).toBeDefined();
    if (!ask || ask.type !== 'ask.requested') return;
    expect(ask.requestId).toBe('pi-dlg-1');
    expect(ask.questions[0]?.options.map((option) => option.label)).toEqual(['Allow once', 'Allow for session', 'Deny']);
    // Nothing was written back yet: the dialog waits for the user, not for a guess.
    expect(fake.written().filter((frame) => frame.type === 'extension_ui_response')).toEqual([]);

    // The cockpit's reply seam delivers `<header>: <label>` (ask-card.tsx).
    expect(session.sendMessage([{ type: 'text', text: 'Approval: Deny' }])).toBe(true);
    const frames = fake.written();
    expect(frames.filter((frame) => frame.type === 'extension_ui_response')).toEqual([
      { type: 'extension_ui_response', id: 'dlg-1', value: 'Deny' },
    ]);
    // …and it did NOT become a second prompt: the turn pi is blocked on is still the first.
    expect(frames.filter((frame) => frame.type === 'prompt')).toHaveLength(1);

    fake.write(JSON.stringify({ type: 'agent_settled' }));
    fake.finish(0);
    await session.result;
    expect(events.some((event) => event.type === 'note' && /answered "Deny"/.test(event.message))).toBe(true);
  });

  it('sends pi the exact choice behind the card label — a comma inside it and a label shortened to fit both survive (#411 review)', async () => {
    const fake = scriptedPi();
    spawnHook.override = () => fake.child;
    const spawned = whenSpawned();
    const uiEvents: UiEvent[] = [];
    const session = new PiRunner({ bin: 'pi', timeoutMs: 20_000, supportsMcpConfig: NO_MCP_CONFIG }).startSession(
      { userPrompt: 'CALL health', cwd: process.cwd() },
      undefined,
      { onUiEvent: (event) => uiEvents.push(event) },
    );
    const long = 'Allow for the whole session and never ask again'.padEnd(61, '.');
    expect(long).toHaveLength(61);
    fake.write(
      JSON.stringify({ type: 'extension_ui_request', id: 'dlg-2', method: 'select', title: 'MCP: xezar wants to run health', options: ['Allow, once', long, 'Deny'] }),
    );
    await tick();
    const ask = uiEvents.find((event) => event.type === 'ask.requested');
    if (!ask || ask.type !== 'ask.requested') throw new Error('expected an ask card');
    const labels = ask.questions[0]?.options.map((option) => option.label) ?? [];
    expect(labels[0]).toBe('Allow, once');
    expect(labels[1]).toHaveLength(60);

    // The card's reply seam sends the label it showed; pi must get the value it offered.
    expect(session.sendMessage([{ type: 'text', text: `Approval: ${labels[1]}` }])).toBe(true);
    expect(fake.written().filter((frame) => frame.type === 'extension_ui_response')).toEqual([
      { type: 'extension_ui_response', id: 'dlg-2', value: long },
    ]);

    fake.write(
      JSON.stringify({ type: 'extension_ui_request', id: 'dlg-3', method: 'select', title: 'MCP: xezar wants to run health', options: ['Allow, once', long, 'Deny'] }),
    );
    await tick();
    expect(session.sendMessage([{ type: 'text', text: 'Approval: Allow, once' }])).toBe(true);
    expect(fake.written().filter((frame) => frame.type === 'extension_ui_response').at(-1)).toEqual({
      type: 'extension_ui_response',
      id: 'dlg-3',
      value: 'Allow, once',
    });
    fake.write(JSON.stringify({ type: 'agent_settled' }));
    fake.finish(0);
    await session.result;
  });

  it('sends pi the case-distinct choice the card named, not its case-twin (#411 review round 2)', async () => {
    const fake = scriptedPi();
    spawnHook.override = () => fake.child;
    const spawned = whenSpawned();
    const uiEvents: UiEvent[] = [];
    const session = new PiRunner({ bin: 'pi', timeoutMs: 20_000, supportsMcpConfig: NO_MCP_CONFIG }).startSession(
      { userPrompt: 'CALL health', cwd: process.cwd() },
      undefined,
      { onUiEvent: (event) => uiEvents.push(event) },
    );
    await spawned;
    fake.write(
      JSON.stringify({ type: 'extension_ui_request', id: 'dlg-4', method: 'select', title: 'MCP: xezar wants to run health', options: ['Allow', 'allow', 'Deny'] }),
    );
    await tick();
    const ask = uiEvents.find((event) => event.type === 'ask.requested');
    if (!ask || ask.type !== 'ask.requested') throw new Error('expected an ask card');
    expect(ask.questions[0]?.options.map((option) => option.label)).toEqual(['Allow', 'allow', 'Deny']);

    // Clicking the second card option must reach pi's second choice.
    expect(session.sendMessage([{ type: 'text', text: 'Approval: allow' }])).toBe(true);
    expect(fake.written().filter((frame) => frame.type === 'extension_ui_response')).toEqual([
      { type: 'extension_ui_response', id: 'dlg-4', value: 'allow' },
    ]);
    fake.write(JSON.stringify({ type: 'agent_settled' }));
    fake.finish(0);
    await session.result;
  });

  it('refuses at once in an autonomous session, and records the refusal', async () => {
    const fake = scriptedPi();
    spawnHook.override = () => fake.child;
    const spawned = whenSpawned();
    const events: AgentEvent[] = [];
    const uiEvents: UiEvent[] = [];
    const session = new PiRunner({ bin: 'pi', timeoutMs: 20_000, supportsMcpConfig: NO_MCP_CONFIG }).startSession(
      { userPrompt: 'CALL health', cwd: process.cwd() },
      (event) => events.push(event),
      { onUiEvent: (event) => uiEvents.push(event), autonomous: true },
    );
    await spawned;
    fake.write(APPROVAL_DIALOG);
    await tick();

    expect(fake.written().filter((frame) => frame.type === 'extension_ui_response')).toEqual([
      { type: 'extension_ui_response', id: 'dlg-1', value: 'Deny' },
    ]);
    // No card: an autonomous run never parks `waiting` on a question nobody will answer.
    expect(uiEvents.some((event) => event.type === 'ask.requested')).toBe(false);
    expect(events.some((event) => event.type === 'note' && /autonomous run.*answered "Deny"/.test(event.message))).toBe(true);

    fake.write(JSON.stringify({ type: 'agent_settled' }));
    fake.finish(0);
    await session.result;
  });

  it('dismisses a dialog the card cannot show instead of leaving pi blocked on it', async () => {
    const fake = scriptedPi();
    spawnHook.override = () => fake.child;
    const spawned = whenSpawned();
    const events: AgentEvent[] = [];
    const session = new PiRunner({ bin: 'pi', timeoutMs: 20_000, supportsMcpConfig: NO_MCP_CONFIG }).startSession(
      { userPrompt: 'do it', cwd: process.cwd() },
      (event) => events.push(event),
    );
    await spawned;
    fake.write(JSON.stringify({ type: 'extension_ui_request', id: 'in-1', method: 'input', title: 'Enter a value' }));
    await tick();
    expect(fake.written().filter((frame) => frame.type === 'extension_ui_response')).toEqual([
      { type: 'extension_ui_response', id: 'in-1', cancelled: true },
    ]);
    expect(events.some((event) => event.type === 'note' && /dismissed a "input"/.test(event.message))).toBe(true);
    fake.finish(0);
    await session.result;
  });

  it('dismisses a pending dialog at session close, so pi ends its turn on its own protocol', async () => {
    const fake = scriptedPi();
    spawnHook.override = () => fake.child;
    const spawned = whenSpawned();
    const session = new PiRunner({ bin: 'pi', timeoutMs: 20_000, supportsMcpConfig: NO_MCP_CONFIG }).startSession({ userPrompt: 'do it', cwd: process.cwd() });
    await spawned;
    fake.write(APPROVAL_DIALOG);
    await tick();
    session.end();
    expect(fake.written().filter((frame) => frame.type === 'extension_ui_response')).toEqual([
      { type: 'extension_ui_response', id: 'dlg-1', cancelled: true },
    ]);
    fake.finish(0);
    await session.result;
  });

  it('GUARD: a fire-and-forget notify gets no response — pi expects none (passes with and without the fix)', async () => {
    const fake = scriptedPi();
    spawnHook.override = () => fake.child;
    const spawned = whenSpawned();
    const uiEvents: UiEvent[] = [];
    const session = new PiRunner({ bin: 'pi', timeoutMs: 20_000, supportsMcpConfig: NO_MCP_CONFIG }).startSession(
      { userPrompt: 'do it', cwd: process.cwd() },
      undefined,
      { onUiEvent: (event) => uiEvents.push(event) },
    );
    await spawned;
    fake.write(JSON.stringify({ type: 'extension_ui_request', id: 'n-1', method: 'notify', message: 'MCP: xezar connected', notifyType: 'info' }));
    fake.write(JSON.stringify({ type: 'extension_ui_request', id: 's-1', method: 'setStatus', statusKey: 'mcp', statusText: 'ok' }));
    await tick();
    expect(fake.written().filter((frame) => frame.type === 'extension_ui_response')).toEqual([]);
    expect(uiEvents.some((event) => event.type === 'ask.requested')).toBe(false);
    fake.finish(0);
    await session.result;
  });
});

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

  async function withFakeChild(
    run: (fake: ReturnType<typeof signallableChild> & { spawned: Promise<void> }) => Promise<void>,
  ): Promise<void> {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    const spawned = whenSpawned();
    vi.useFakeTimers();
    try {
      await run({ ...fake, spawned });
    } finally {
      vi.useRealTimers();
      spawnHook.override = null;
    }
  }

  it('force-kills a pi that survives the SIGTERM its timeout sent', async () => {
    await withFakeChild(async (fake) => {
      const session = new PiRunner({ bin: 'pi', timeoutMs: 20, supportsMcpConfig: NO_MCP_CONFIG }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);
      await fake.spawned;

      vi.advanceTimersByTime(20);
      expect(fake.signals).toEqual(['SIGTERM']);
      // Delivered, not dead — the state that used to disable every escalation (#844).
      expect(fake.child.killed).toBe(true);
      expect(fake.child.exitCode).toBeNull();

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('stops escalating once pi really exits after the SIGTERM', async () => {
    await withFakeChild(async (fake) => {
      const session = new PiRunner({ bin: 'pi', timeoutMs: 20, supportsMcpConfig: NO_MCP_CONFIG }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);
      await fake.spawned;

      vi.advanceTimersByTime(20);
      expect(fake.signals).toEqual(['SIGTERM']);
      fake.exit(143);

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
    });
  });

  it('still signals when the session had already auto-ended (the `open` guard)', async () => {
    // `autoEndAfterFirstTurn` sets `open = false`; the old `interrupt()` returned early on
    // that, so the deadline fired into a no-op and nothing was ever killed.
    await withFakeChild(async (fake) => {
      const session = new PiRunner({ bin: 'pi', timeoutMs: 20, supportsMcpConfig: NO_MCP_CONFIG }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);
      await fake.spawned;
      session.end();
      fake.signals.length = 0;

      vi.advanceTimersByTime(20);
      expect(fake.signals).toContain('SIGTERM');
      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toContain('SIGKILL');
    });
  });

  it('arms no wall clock at all when the step disabled it (timeoutMs: 0)', async () => {
    await withFakeChild(async (fake) => {
      const session = new PiRunner({ bin: 'pi', timeoutMs: 0, supportsMcpConfig: NO_MCP_CONFIG }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);
      await fake.spawned;

      vi.advanceTimersByTime(60 * 60_000);
      expect(fake.signals).toEqual([]);
    });
  });
});

/**
 * #648 — the three minors the #636 second-opinion review recorded against the `--mcp-config`
 * capability-probe facade. All three live in the window between `startSession` returning and the
 * child existing, which is the window PR #636 opened.
 *
 * Named break for the red proofs: `pi-probe-facade-pre-648` — restore `pi-runner.ts` to its
 * fc461704 state (the facade that records only pre-adopt sends, spawns regardless of an interrupt
 * and holds no probe handle). Measured against that copy: A fails on the replayed message, B on
 * both the interrupt and the close case, C by hanging until the test's own timeout.
 *
 * The GUARD case below pins what must NOT change — #588/#548: the probe is still asked BEFORE the
 * child is spawned, and an answer that is not `yes` still fails closed to a session without the
 * flag. It passes with and without the fix.
 */
describe('the pi capability-probe facade (#648)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'xez-pi-facade-'));
  });
  afterEach(() => {
    spawnHook.override = null;
    spawnHook.onSpawn = null;
    rmSync(cwd, { recursive: true, force: true });
  });

  /** Let the awaited probe answer run the facade's next steps — a spawn, if it still makes one. */
  const settleProbe = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

  /** A fake pi child that records what was written to it and how it was signalled. */
  function fakeChild(pid: number): {
    child: ChildProcessWithoutNullStreams;
    prompts: () => string[];
    signals: NodeJS.Signals[];
    die: (code: number, stderr?: string) => void;
  } {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const signals: NodeJS.Signals[] = [];
    let captured = '';
    stdin.on('data', (chunk: Buffer | string) => {
      captured += chunk.toString();
    });
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin,
      stdout,
      stderr,
      pid,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal);
        Object.assign(child, { killed: true });
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    return {
      child,
      signals,
      prompts: () =>
        captured
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((frame) => frame.type === 'prompt')
          .map((frame) => String(frame.message)),
      die: (code: number, text?: string) => {
        if (text) stderr.write(text);
        Object.assign(child, { exitCode: code });
        stdout.end();
        emitter.emit('exit', code, null);
        emitter.emit('close', code, null);
      },
    };
  }

  // ---- A: a message handed over after the first child was adopted ----

  it('replays a message sent AFTER the first child was adopted onto the restarted child', async () => {
    const first = fakeChild(6001);
    const second = fakeChild(6002);
    const children = [first, second];
    let spawns = 0;
    spawnHook.override = () => children[spawns++]?.child;

    const firstSpawned = whenSpawned();
    // `yes` is the only answer that arms the one-shot restart, which is what replays anything.
    const session = new PiRunner({ bin: 'pi', timeoutMs: 0, supportsMcpConfig: async () => 'yes' }).startSession(
      { userPrompt: 'do it', cwd },
    );
    void session.result.catch(() => undefined);
    await firstSpawned;

    // The window the review measured: the facade has a live child, and the person types.
    expect(session.sendMessage([{ type: 'text', text: 'and also this' }])).toBe(true);
    expect(first.prompts()).toEqual(['do it', 'and also this']);

    const secondSpawned = whenSpawned();
    // …and that child dies at spawn on the very flag the probe said it knew.
    first.die(1, 'Error: Unknown option: --mcp-config\n');
    await secondSpawned;

    expect(spawns).toBe(2);
    // The replacement gets BOTH: the opening prompt rides `spec.userPrompt`, and the message the
    // dead attempt was handed goes back on the queue instead of dying with it.
    expect(second.prompts()).toEqual(['do it', 'and also this']);

    second.die(0);
    await session.result;
  });

  // ---- B: an interrupt or a close inside the probe window ----

  it('spawns no child at all when the session is interrupted inside the probe window', async () => {
    let spawns = 0;
    spawnHook.override = () => {
      spawns += 1;
      return fakeChild(6003).child;
    };
    let answer!: (value: PiMcpConfigAnswer) => void;
    const probe = new Promise<PiMcpConfigAnswer>((resolve) => {
      answer = resolve;
    });

    const events: AgentEvent[] = [];
    const uiEvents: UiEvent[] = [];
    const session = new PiRunner({ bin: 'pi', timeoutMs: 0, supportsMcpConfig: () => probe }).startSession(
      { userPrompt: 'do it', cwd },
      (event) => events.push(event),
      { onUiEvent: (event) => uiEvents.push(event) },
    );

    session.interrupt();
    answer('yes'); // the probe answers anyway — nobody wants the answer any more
    // Read the spawn count before settling: a facade that spawns here leaves a child nothing
    // will ever drive, so waiting for the result first would report a timeout instead of the bug.
    await settleProbe();

    expect(spawns).toBe(0);
    const result = await session.result;
    expect(result.text).toBe('');
    expect(events.some((event) => event.type === 'note' && event.message.includes('no pi was spawned'))).toBe(true);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(uiEvents).toContainEqual({ type: 'session.ended', reason: 'cancelled' });
  });

  it('spawns no child when the session is closed inside the probe window', async () => {
    let spawns = 0;
    spawnHook.override = () => {
      spawns += 1;
      return fakeChild(6004).child;
    };
    let answer!: (value: PiMcpConfigAnswer) => void;
    const probe = new Promise<PiMcpConfigAnswer>((resolve) => {
      answer = resolve;
    });

    const session = new PiRunner({ bin: 'pi', timeoutMs: 0, supportsMcpConfig: () => probe }).startSession(
      { userPrompt: 'do it', cwd },
    );

    session.end();
    expect(session.open).toBe(false);
    answer('no');
    await settleProbe();

    // A session that already reports itself closed must not acquire a child — which would also
    // flip `open` back to true.
    expect(spawns).toBe(0);
    expect(session.open).toBe(false);
    await session.result;
  });

  // ---- C: the in-flight probe itself ----

  it('kills the in-flight probe child on interrupt instead of waiting out its bound', async () => {
    const probeChild = fakeChild(6005);
    let spawns = 0;
    spawnHook.override = () => {
      spawns += 1;
      return probeChild.child;
    };
    const probeSpawned = whenSpawned();
    // Fake timers, so `MCP_CONFIG_PROBE_TIMEOUT_MS` CANNOT be what ends this: nothing here
    // advances them, and the probe child never exits on its own.
    vi.useFakeTimers();
    try {
      // The real probe, not an injected one — the kill lives in it.
      const session = new PiRunner({ bin: 'pi', timeoutMs: 0 }).startSession({ userPrompt: 'do it', cwd });
      await probeSpawned;
      expect(spawns).toBe(1);

      session.interrupt();

      expect(probeChild.signals).toEqual(['SIGKILL']);
      await session.result;
      // The probe was the only child: the session never spawned a pi of its own.
      expect(spawns).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ---- GUARD: what #548/#588 made load-bearing, unchanged either way ----

  it('GUARD: the probe still runs BEFORE the spawn, and an unanswerable probe still fails closed', async () => {
    const child = fakeChild(6006);
    const order: string[] = [];
    spawnHook.override = () => {
      order.push('spawn');
      return child.child;
    };
    const spawned = whenSpawned();
    const events: AgentEvent[] = [];
    const session = new PiRunner({
      bin: 'pi',
      timeoutMs: 0,
      supportsMcpConfig: async () => {
        order.push('probe');
        return 'unknown';
      },
    }).startSession({ userPrompt: 'do it', cwd }, (event) => events.push(event));
    await spawned;

    // The ordering #588 turned on: ask first, spawn second.
    expect(order).toEqual(['probe', 'spawn']);
    // …and an answer that is not `yes` still leaves the flag out, with the note that says only
    // what was established.
    expect(events.some((event) => event.type === 'note' && event.message.includes('could not confirm'))).toBe(true);
    expect(child.prompts()).toEqual(['do it']);

    child.die(0);
    await session.result;
  });
});
