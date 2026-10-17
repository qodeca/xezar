import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmptyPath } from '../../test/helpers/empty-path.ts';
import { FILE_SYMLINKS, linkDir, onWindows, withPlatform, TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import { projectStateLayout, setActiveStateLayout } from '../state-layout.ts';
import type { AgentEvent } from './agent-runner.js';
import { KILL_GRACE_MS } from './claude-cli-runner.js';
import { CodexAppServerRunner, codexPermissions, codexReadOnlyHook, codexWindowsSandboxConfig } from './codex-app-server-runner.js';

const hostCodexHome = process.env.CODEX_HOME;
beforeEach(() => {
  delete process.env.CODEX_HOME;
});
afterEach(() => {
  if (hostCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = hostCodexHome;
});

/** Only the escalation tests below swap the child out; every other test in this
 *  file keeps spawning the real mock app-server through the untouched `spawn`. */
const spawnHook = vi.hoisted(() => ({ override: null as null | (() => unknown) }));

useEmptyPath();

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnHook.override ? spawnHook.override() : actual.spawn(...args),
  };
});

/**
 * #703 backend parity — `claude-cli-runner.test.ts` proves the Claude half;
 * this is the same session-level shape for Codex. The fix only holds if BOTH
 * runners classify a xezar-initiated 128+signal exit as a teardown note rather
 * than an agent failure, so the Codex branch needs its own regression.
 */
describe('a teardown xezar initiated (codex app-server)', () => {
  const mockBin = fileURLToPath(
    new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url),
  );

  it('settles the session instead of failing it when the app-server exits 143', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    let sawText: () => void = () => {};
    const firstText = new Promise<void>((resolve) => {
      sawText = resolve;
    });
    const session = runner.startSession(
      // MOCK_CODEX_IGNORE_EOF makes the mock stay deaf to stdin EOF and exit
      // 143 on SIGTERM — the real shape reported in #703.
      { userPrompt: 'check the working tree', cwd: process.cwd(), env: { MOCK_CODEX_IGNORE_EOF: '1' } },
      (event) => {
        events.push(event);
        if (event.type === 'text') sawText();
      },
    );
    await firstText;

    // The cancel path; the EOF watchdog reaches the same `terminatedByXezar`.
    session.interrupt();
    const result = await session.result;

    expect(result.text).toBe('Checking the working tree.');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done' });
    // win32-skip(#974): Node reports a Windows kill as exit code null, so no exit code reaches the note
    if (!onWindows) {
      expect(
        events.some((e) => e.type === 'note' && e.message.includes('terminated by xezar (code 143)')),
      ).toBe(true);
    }
  }, 15_000);

  it('surfaces a failed turn as an AgentEvent error', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'mock:turn-failed', cwd: process.cwd() },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );

    await session.result;

    expect(events).toContainEqual({ type: 'error', message: 'model unavailable' });
    expect(events).toContainEqual({ type: 'turn-end' });
  }, 15_000);

  it('persists blocked Bash and apply_patch hook feedback as run-event notes', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'mock:hook-blocked', cwd: process.cwd() },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );

    await session.result;

    expect(events).toContainEqual({
      type: 'note',
      message: 'codex: PreToolUse blocked: Rule prefix.entry refused the command: it did not match any bashAllowlist entry.',
    });
    expect(events).toContainEqual({
      type: 'note',
      message: 'codex: PreToolUse blocked: Rule payload.tool-name refused the command: tool "apply_patch" is not the Bash shell tool.',
    });
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'note',
      message: expect.stringContaining('third-party Stop hook'),
    }));
  }, 15_000);

  it('caps each blocked PreToolUse reason with a truncation marker', async () => {
    const events: AgentEvent[] = [];
    const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
      { userPrompt: 'mock:hook-blocked-long', cwd: process.cwd() },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );

    await session.result;

    const note = events.find((event) => event.type === 'note' && event.message.startsWith('codex: PreToolUse blocked:'));
    expect(note).toEqual(expect.objectContaining({ type: 'note' }));
    if (!note || note.type !== 'note') throw new Error('blocked-hook note was not emitted');
    const reason = note.message.slice('codex: PreToolUse blocked: '.length);
    expect(reason).toHaveLength(2_000);
    expect(reason).toMatch(/\[truncated\]$/);
  }, 15_000);
});

describe('Codex quota telemetry', () => {
  const mockBin = fileURLToPath(new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url));

  it('emits account/rateLimits/updated as an internal account-quota event', async () => {
    const events: AgentEvent[] = [];
    const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
      { userPrompt: 'mock:quota', cwd: process.cwd() },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );
    await session.result;
    expect(events).toContainEqual(expect.objectContaining({ type: 'account-quota', runner: 'codex' }));
  });

  it('fails a usageLimitExceeded turn as a dated usage limit instead of a silent turn end (#565)', async () => {
    const events: AgentEvent[] = [];
    const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
      { userPrompt: 'mock:usage-limit', cwd: process.cwd() },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );
    await session.result;
    const limit = events.findIndex((event) => event.type === 'account-limit');
    const error = events.findIndex((event) => event.type === 'error');
    expect(events[limit]).toEqual({
      type: 'account-limit', runner: 'codex', resetAt: '2030-01-01T00:00:00.000Z', reason: 'usageLimitExceeded',
    });
    expect(events[error]).toEqual({
      type: 'error',
      message: "Codex usage limit reached (usageLimitExceeded) — resets at 2030-01-01T00:00:00.000Z. You've hit your usage limit. Try again later.",
    });
    expect(limit).toBeLessThan(error);
    expect(error).toBeLessThan(events.findIndex((event) => event.type === 'turn-end'));
  });

  it('fails a rateLimitExceeded turn as a limit only when the snapshot says a limit was reached', async () => {
    const events: AgentEvent[] = [];
    const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
      { userPrompt: 'mock:rate-limit-reached', cwd: process.cwd() },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );
    await session.result;
    // Dated from the 5-hour window at 100 %, never from the later weekly window at 40 %.
    expect(events).toContainEqual({
      type: 'account-limit', runner: 'codex', resetAt: '2030-01-01T00:00:00.000Z', reason: 'rateLimitExceeded',
    });
    expect(events).toContainEqual({
      type: 'error',
      message: 'Codex rate limit reached (rateLimitExceeded) — resets at 2030-01-01T00:00:00.000Z. Rate limit reached.',
    });
  });

  it('leaves a rateLimitExceeded turn without rateLimitReachedType an ordinary failed turn', async () => {
    const events: AgentEvent[] = [];
    const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
      { userPrompt: 'mock:rate-limit', cwd: process.cwd() },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );
    await session.result;
    // No account-limit: the login is not marked out and no reset reaches auto-resume.
    expect(events.some((event) => event.type === 'error' || event.type === 'account-limit')).toBe(false);
    expect(events).toContainEqual({ type: 'turn-end' });
  });

  it('leaves a failed turn with a non-quota codexErrorInfo exactly as before', async () => {
    const events: AgentEvent[] = [];
    const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
      { userPrompt: 'mock:context-window', cwd: process.cwd() },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );
    await session.result;
    expect(events.some((event) => event.type === 'error' || event.type === 'account-limit')).toBe(false);
    expect(events).toContainEqual({ type: 'turn-end' });
  });

  it('does not fail the run when a quota consumer rejects the payload', async () => {
    const events: AgentEvent[] = [];
    const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
      { userPrompt: 'mock:quota', cwd: process.cwd() },
      (event) => {
        if (event.type === 'account-quota') throw new Error('producer schema rejected payload');
        events.push(event);
      },
      { autoEndAfterFirstTurn: true },
    );
    await expect(session.result).resolves.toMatchObject({ text: 'Checking the working tree.' });
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'error' }));
  });
});

/**
 * #462 — destroying stdout ends the read loop before the timeout's SIGKILL
 * grace period. The escalation must outlive that loop for a real app-server
 * child that catches SIGTERM and deliberately keeps running.
 */
describe('wall-clock timeout for a real Codex child that ignores SIGTERM', () => {
  const TIMEOUT_MS = 2_000;
  const mockBin = fileURLToPath(
    new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url),
  );

  it(
    'keeps the SIGKILL escalation armed until the child exits',
    async () => {
      const events: AgentEvent[] = [];
      // Long enough for the mock to install its SIGTERM handler: at 100 ms a loaded runner had not
      // started it yet, the default SIGTERM ended it at once, and nothing was left to escalate.
      const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: TIMEOUT_MS }).startSession(
        {
          userPrompt: 'check the working tree',
          cwd: process.cwd(),
          env: { MOCK_CODEX_IGNORE_EOF: '1', MOCK_CODEX_IGNORE_SIGTERM: '1' },
        },
        (event) => events.push(event),
      );
      const pid = session.pid;
      const startedAt = Date.now();

      try {
        const result = await Promise.race([
          session.result,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('session stayed pending after the SIGKILL grace period')), TIMEOUT_MS + KILL_GRACE_MS + 3_000),
          ),
        ]);

        // win32-skip(#974): Windows has no catchable SIGTERM, so there is no SIGKILL escalation to wait for
        if (!onWindows) expect(Date.now() - startedAt).toBeGreaterThanOrEqual(TIMEOUT_MS + KILL_GRACE_MS - 500);
        // Windows kills at the time limit, which can come before the mock wrote its first text (#963).
        if (onWindows) expect(['', 'Checking the working tree.']).toContain(result.text);
        else expect(result.text).toBe('Checking the working tree.');
        expect(result.timedOut).toBe(true); // #943: the run manager sweeps after a timeout
        expect(events).toContainEqual({
          type: 'error',
          message: 'codex app-server timed out after 0m and was killed',
        });
        expect(events.at(-1)).toEqual({ type: 'done' });
        expect(() => process.kill(pid!, 0)).toThrow();
      } finally {
        if (pid) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The expected path already reaped it.
          }
        }
      }
    },
    TIMEOUT_MS + KILL_GRACE_MS + 8_000,
  );
});

/**
 * #844 — the runner's own SIGTERM sets `ChildProcess.killed`, so a watchdog
 * gated on `!child.killed` refused to escalate for exactly the app-server it
 * was written for: one that handles the signal and keeps running. The guard now
 * tracks real termination, and `terminatedByXezar` (#703) is still set before
 * every signal so the resulting 137/143 stays a teardown note, not a failure.
 */
describe('SIGTERM→SIGKILL escalation for an app-server that survives SIGTERM', () => {
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
      pid: 4243,
      // Node's semantics: delivery flips `killed` whether or not the child dies.
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

  it('escalates on the wall-clock timeout even after Node flagged the child as killed', () => {
    withFakeChild((fake) => {
      const session = new CodexAppServerRunner({ bin: 'codex', timeoutMs: 20 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      vi.advanceTimersByTime(20);
      expect(fake.signals).toEqual(['SIGTERM']);
      // Delivered, not dead — the state that used to disable the escalation.
      expect(fake.child.killed).toBe(true);
      expect(fake.child.exitCode).toBeNull();

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('stops escalating once the app-server really exits after SIGTERM', () => {
    withFakeChild((fake) => {
      const session = new CodexAppServerRunner({ bin: 'codex', timeoutMs: 20 }).startSession({
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

  it('does not signal a second time once interrupt() saw the child exit', () => {
    withFakeChild((fake) => {
      const session = new CodexAppServerRunner({ bin: 'codex', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);
      fake.exit(0);

      session.interrupt();
      expect(fake.signals).toEqual([]);
    });
  });
});

/**
 * #156 backend parity — the claude runner learned to say who sent the signal
 * behind a 128+signal exit; AGENT_PROTOCOL.md requires the codex branch to
 * report it the same way instead of the bare `exited with code 143`.
 */
describe('a signal xezar did not send (codex app-server)', () => {
  const mockBin = fileURLToPath(
    new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url),
  );

  it('names the signal and says xezar did not send it', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    // The mock exits 143 on its own after a clean turn — the exit is injected,
    // no process is signalled, and the runner never sets `terminatedByXezar`.
    const session = runner.startSession(
      {
        userPrompt: 'check the working tree',
        cwd: process.cwd(),
        env: { MOCK_CODEX_FOREIGN_SIGNAL_EXIT: '1' },
      },
      (event) => events.push(event),
    );

    await expect(session.result).rejects.toThrow(
      /codex app-server was terminated by SIGTERM \(exit 143\) — xezar sent no signal/,
    );
    const error = events.find((event) => event.type === 'error');
    expect(error?.type === 'error' && error.message).toContain('#156');
  }, 15_000);

  /**
   * One cancelled session against the real mock, with the stop delivered by pid instead of
   * through Node's own handle: that is the shape that leaves exit code 1 and no signal on every
   * OS – Windows ends the process with TerminateProcess(1), and on Linux and macOS the mock's
   * SIGTERM handler exits 1 (`MOCK_CODEX_SIGTERM_EXIT_CODE`).
   */
  async function cancelWithExitOne(): Promise<{ events: AgentEvent[]; signals: string[]; result: Promise<unknown> }> {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const signals: string[] = [];
    let spawned: { pid?: number | undefined } | undefined;
    spawnHook.override = () => {
      const child = actual.spawn(process.execPath, [mockBin, 'app-server'], {
        env: { ...process.env, MOCK_CODEX_IGNORE_EOF: '1', MOCK_CODEX_SIGTERM_EXIT_CODE: '1' },
      });
      spawned = child;
      child.kill = (signal?: NodeJS.Signals | number) => {
        signals.push(String(signal));
        if (child.pid !== undefined) process.kill(child.pid, signal);
        return true;
      };
      return child;
    };
    const events: AgentEvent[] = [];
    let sawText: () => void = () => {};
    const firstText = new Promise<void>((resolve) => {
      sawText = resolve;
    });
    let stopped = false;
    try {
      const session = new CodexAppServerRunner({ bin: 'codex', timeoutMs: 0 }).startSession(
        { userPrompt: 'check the working tree', cwd: process.cwd() },
        (event) => {
          events.push(event);
          if (event.type === 'text') sawText();
        },
      );
      // Bounded, so a mock that never answers fails here and its process is still ended below.
      await Promise.race([
        firstText,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('no first text from the mock app-server')), 10_000).unref()),
      ]);
      session.interrupt();
      stopped = true;
      return { events, signals, result: session.result };
    } finally {
      spawnHook.override = null;
      // The mock ignores EOF and runs for ever: a helper that failed before its stop ends it (T-11).
      if (!stopped && spawned?.pid !== undefined) {
        try {
          process.kill(spawned.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }

  /**
   * #963 AC-7 — on Windows a stop that does not go through Node's own handle leaves exit code 1
   * and no signal; with the #703 flag set that is our own stop, not a codex failure.
   */
  it('settles a xezar-initiated stop on Windows, which exits 1', async () => {
    await withPlatform('win32', async () => {
      const { events, signals, result } = await cancelWithExitOne();

      await result;
      expect(signals).toEqual(['SIGTERM']);
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(
        events.some((event) => event.type === 'note' && event.message.includes('terminated by xezar (code 1)')),
      ).toBe(true);
      expect(events.at(-1)).toEqual({ type: 'done' });
    });
  }, 15_000);

  /** GUARD — Linux and macOS are unchanged: exit 1 after our own SIGTERM is still a failure. */
  it('still fails an exit 1 after a xezar stop on Linux and macOS', async () => {
    await withPlatform('linux', async () => {
      const { events, result } = await cancelWithExitOne();

      await expect(result).rejects.toThrow(/^codex app-server exited with code 1/);
      expect(events.some((event) => event.type === 'note' && event.message.includes('terminated by xezar'))).toBe(
        false,
      );
    });
  }, 15_000);
});

/**
 * #324 / #323 — a Codex run xezar starts must not reach the person's own MCP servers, plugins
 * or apps, nor xezar's leader bridge. Under MOCK_CODEX_AMBIENT the mock reports one server per
 * case through `config/read` and refuses a thread whose `config` does not switch the right ones
 * off, so each of these fails against a runner that starts the thread without asking.
 */
describe("a Codex run does not reach the person's own MCP servers (#324)", () => {
  const mockBin = fileURLToPath(
    new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url),
  );

  it('starts the thread with only the project server, and says what it switched off', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'check the working tree', cwd: process.cwd(), env: { MOCK_CODEX_AMBIENT: '1' } },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );

    await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' });
    const notes = events.flatMap((event) => (event.type === 'note' ? [event.message] : []));
    expect(notes.some((note) => note.includes('off: __proto__, ambient, envleader, mixed, nodeleader, xezar'))).toBe(true);
    expect(notes.join('\n')).not.toContain('projsrv');
    // #1007: the project server the home config also names runs on the project's definition
    // (the mock refuses the thread otherwise), and `mixed`, whose home `env` no override can
    // leave out, stays off with the key path named.
    expect(notes.join('\n')).toContain("clash is set up with the project's own settings only");
    expect(notes.join('\n')).toContain('the project server mixed stays off because your own Codex config also sets env.TOOL_HOME');
    expect(notes.join('\n')).not.toContain('/home/u/tool');
  }, 15_000);

  it('keeps the same isolation when a stored thread is resumed', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const session = runner.startSession(
      { userPrompt: 'continue', cwd: process.cwd(), resume: true, sessionId: 'th_mock_1', env: { MOCK_CODEX_AMBIENT: '1' } },
      undefined,
      { autoEndAfterFirstTurn: true },
    );

    await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' });
  }, 15_000);

  /**
   * #942: Continue after a long Codex step died with `Invalid string length`. By default
   * `thread/resume` answers with the thread's whole history in ONE JSON-RPC line, and a long
   * session's line passes the runtime's string ceiling. The mock pads that line to 1 MB and the
   * runner's read limit is lowered to 64 KB, so the real-size failure is reproduced in miniature.
   */
  describe('resuming a thread whose history is larger than the read limit (#942)', () => {
    const LIMIT = 64 * 1024;
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'xez-942-'));
    });
    afterEach(() => {
      rmSync(dir, TEST_DIR_RM_OPTIONS);
    });

    function resume(env: Record<string, string>) {
      const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0, maxMessageChars: LIMIT });
      return runner.startSession(
        { userPrompt: 'continue', cwd: dir, resume: true, sessionId: 'th_mock_1', env },
        undefined,
        { autoEndAfterFirstTurn: true },
      ).result;
    }

    it('resumes: the request asks Codex to leave the history out of its reply', async () => {
      const log = join(dir, 'thread.ndjson');
      await expect(resume({ MOCK_CODEX_RESUME_HISTORY_CHARS: String(1024 * 1024), MOCK_CODEX_THREAD_LOG: log }))
        .resolves.toMatchObject({ sessionId: 'th_mock_1' });
      const [request] = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
        method: string;
        params: Record<string, unknown>;
      });
      expect(request).toMatchObject({ method: 'thread/resume', params: { threadId: 'th_mock_1', excludeTurns: true } });
    }, 15_000);

    it('fails with a readable reason naming the history file and its size when Codex sends the history anyway', async () => {
      const day = join(dir, 'codex-home', 'sessions', '2026', '09', '25');
      mkdirSync(day, { recursive: true });
      const rollout = join(day, 'rollout-2026-09-25T10-00-00-th_mock_1.jsonl');
      writeFileSync(rollout, 'y'.repeat(3 * 1024 * 1024));
      const error = await resume({
        MOCK_CODEX_RESUME_HISTORY_CHARS: String(1024 * 1024),
        MOCK_CODEX_IGNORE_EXCLUDE_TURNS: '1',
        MOCK_CODEX_HOME: join(dir, 'codex-home'),
      }).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).not.toMatch(/Invalid string length/);
      expect(message).toMatch(/^codex app-server sent one message larger than xezar can read \(at least \d+ KB; the limit is 64 KB\) while resuming Codex thread th_mock_1\./);
      expect(message).toContain(`The thread's stored history is ${rollout} (3 MB).`);
      expect(message).toContain('start a fresh task in the same worktree');
    }, 15_000);

    it('still names the thread and size when the history file cannot be found', async () => {
      const error = await resume({
        MOCK_CODEX_RESUME_HISTORY_CHARS: String(1024 * 1024),
        MOCK_CODEX_IGNORE_EXCLUDE_TURNS: '1',
        MOCK_CODEX_HOME: join(dir, 'no-such-home'),
      }).catch((err: unknown) => err);
      expect((error as Error).message).toMatch(/at least \d+ KB; the limit is 64 KB\) while resuming Codex thread th_mock_1\. This session/);
    }, 15_000);

    it('resumes a short history exactly as before, even on a Codex that ignores excludeTurns', async () => {
      await expect(resume({ MOCK_CODEX_RESUME_HISTORY_CHARS: '1000', MOCK_CODEX_IGNORE_EXCLUDE_TURNS: '1' }))
        .resolves.toMatchObject({ sessionId: 'th_mock_1' });
    }, 15_000);
  });

  it('names an MCP server that failed to start, and only for its own thread (#1026)', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'check the working tree', cwd: process.cwd(), env: { MOCK_CODEX_MCP_STARTUP_FAILED: '1' } },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );

    await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' });
    const notes = events.flatMap((event) => (event.type === 'note' ? [event.message] : []));
    expect(notes).toContain(
      'codex: the MCP server browser did not start: MCP client for `browser` timed out after 30 seconds. This run has none of its tools (#1026).',
    );
    // `docs` started: since #1057 it has a ready note of its own, never a failure note.
    expect(notes.join('\n')).not.toContain('docs did not start');
    expect(notes.join('\n')).not.toContain('MCP server other');
  }, 15_000);

  describe('names an MCP server that reports ready, with its tool count (#1057)', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'xez-1057-'));
    });
    afterEach(() => {
      rmSync(dir, TEST_DIR_RM_OPTIONS);
    });

    const run = async (env: Record<string, string>) => {
      const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
      const events: AgentEvent[] = [];
      const log = join(dir, 'rpc.ndjson');
      const session = runner.startSession(
        { userPrompt: 'check the working tree', cwd: process.cwd(), env: { MOCK_CODEX_MCP_STARTUP_FAILED: '1', MOCK_CODEX_RPC_LOG: log, ...env } },
        (event) => events.push(event),
        { autoEndAfterFirstTurn: true },
      );
      await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' });
      const notes = events.flatMap((event) => (event.type === 'note' ? [event.message] : []));
      const listRequests = readFileSync(log, 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
        .filter((entry) => entry.method === 'mcpServerStatus/list');
      return { notes, listRequests };
    };

    it('notes each ready server once, for its own thread only, with the count Codex lists', async () => {
      const { notes, listRequests } = await run({});
      expect(notes.filter((note) => note.includes('MCP server docs'))).toEqual(['codex: the MCP server docs is ready with 3 tools.']);
      // A sub-agent thread's ready server adds nothing, and is never looked up.
      expect(notes.join('\n')).not.toContain('helper');
      expect(listRequests.map((entry) => entry.params)).toEqual([
        { threadId: 'th_mock_1', detail: 'toolsAndAuthOnly' },
        { threadId: 'th_mock_1', detail: 'toolsAndAuthOnly', cursor: 'page-2' },
      ]);
      // The #1026 failed-start note is unchanged.
      expect(notes).toContain(
        'codex: the MCP server browser did not start: MCP client for `browser` timed out after 30 seconds. This run has none of its tools (#1026).',
      );
    }, 15_000);

    it('still names the server, without a count, when the status listing fails', async () => {
      const { notes } = await run({ MOCK_CODEX_MCP_STATUS_LIST: 'error' });
      expect(notes.filter((note) => note.includes('MCP server docs'))).toEqual(['codex: the MCP server docs is ready.']);
    }, 15_000);
  });

  it('fails closed when the app-server cannot say which servers it would load', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'check the working tree', cwd: process.cwd(), env: { MOCK_CODEX_CONFIG_READ_ERROR: '1' } },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );

    await expect(session.result).rejects.toThrow(/could not list the MCP servers.*Method not found: config\/read/);
    expect(events.some((event) => event.type === 'tool-call')).toBe(false);
  }, 15_000);
});

/**
 * #849 C (revised after the #850 review) — a read-only step (its `allowedTools` names neither Edit
 * nor Write) runs the thread CONFINED: `workspace-write` with network on and the run's own
 * directories as the only writable roots besides the worktree, on start AND on resume; every other
 * step keeps the sandbox it had. The mock refuses a thread whose sandbox differs from
 * MOCK_CODEX_EXPECT_SANDBOX and logs each thread request, so the params are pinned whole rather
 * than one field at a time.
 */
describe('a read-only step runs Codex confined to its worktree and its own roots (#849)', () => {
  const mockBin = fileURLToPath(
    new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url),
  );
  const REVIEW = ['Read', 'Grep', 'Glob', 'Bash'];
  const DEFAULT = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'];
  const ROOTS = ['/data/runs', '/data/tasks/run-1', '/data/tmp/run-1'];
  const noServers = { features: { plugins: false, apps: false } };
  const confined = {
    ...noServers,
    sandbox_workspace_write: { network_access: true, writable_roots: ROOTS },
    // #1009: on a Windows host the thread also chooses the Windows sandbox, or Codex runs read-only.
    ...codexWindowsSandboxConfig('workspace-write'),
  };
  let cacheProject: string;

  beforeEach(() => {
    cacheProject = mkdtempSync(join(tmpdir(), 'xez-863-cache-'));
    setActiveStateLayout(projectStateLayout(cacheProject));
  });

  afterEach(() => {
    setActiveStateLayout(null);
    rmSync(cacheProject, TEST_DIR_RM_OPTIONS);
  });

  async function threadRequest(opts: { allowedTools: string[]; expect: string; resume?: boolean; bashAllowlist?: string[] }) {
    const dir = mkdtempSync(join(tmpdir(), 'xez-849-'));
    const log = join(dir, 'thread.ndjson');
    try {
      const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
      const session = runner.startSession(
        {
          userPrompt: 'review it',
          cwd: dir,
          allowedTools: opts.allowedTools,
          ...(opts.bashAllowlist === undefined ? {} : { bashAllowlist: opts.bashAllowlist }),
          additionalDirectories: ROOTS,
          ...(opts.resume ? { resume: true, sessionId: 'th_mock_1' } : {}),
          env: { MOCK_CODEX_EXPECT_SANDBOX: opts.expect, MOCK_CODEX_THREAD_LOG: log, MOCK_CODEX_HOME: dir },
        },
        undefined,
        { autoEndAfterFirstTurn: true },
      );
      await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' });
      // `cwd` is the run's own temp dir; swap it for a stable token so the params pin whole.
      // The log is JSON, so a Windows `dir` sits in it with every `\` doubled (#963).
      const inJson = JSON.stringify(dir).slice(1, -1);
      return readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line.split(inJson).join('<cwd>')) as unknown);
    } finally {
      rmSync(dir, TEST_DIR_RM_OPTIONS);
    }
  }

  it('starts the code-review thread confined: workspace-write, network on, the run roots writable', async () => {
    expect(await threadRequest({ allowedTools: REVIEW, expect: 'workspace-write' })).toEqual([
      { method: 'thread/start', params: { cwd: '<cwd>', sandbox: 'workspace-write', approvalPolicy: 'never', config: confined } },
    ]);
  }, 15_000);

  it('resumes the code-review thread with the same confined params', async () => {
    expect(await threadRequest({ allowedTools: REVIEW, expect: 'workspace-write', resume: true })).toEqual([
      {
        method: 'thread/resume',
        params: { threadId: 'th_mock_1', excludeTurns: true, cwd: '<cwd>', sandbox: 'workspace-write', approvalPolicy: 'never', config: confined },
      },
    ]);
  }, 15_000);

  it.each([
    ['starts', false],
    ['resumes', true],
  ] as const)('%s with the Bash hook registered and trusted before turn 1', async (_name, resume) => {
    const spec = { userPrompt: 'review it', cwd: '/repo', allowedTools: REVIEW, bashAllowlist: [' git status ', ''] };
    const hook = codexReadOnlyHook(spec)!;
    const requests = await threadRequest({
      allowedTools: REVIEW,
      bashAllowlist: spec.bashAllowlist,
      expect: 'workspace-write',
      resume,
    });
    expect(requests).toEqual([{
      method: resume ? 'thread/resume' : 'thread/start',
      params: {
        ...(resume ? { threadId: 'th_mock_1', excludeTurns: true } : {}),
        cwd: '<cwd>',
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        config: { ...confined, hooks: hook.config },
      },
    }]);
  }, 15_000);

  it('fails closed before turn/start when the headless hook trust grant is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xez-863-trust-'));
    const log = join(dir, 'rpc.ndjson');
    try {
      const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
        {
          userPrompt: 'review it',
          cwd: dir,
          allowedTools: REVIEW,
          bashAllowlist: ['git status'],
          env: {
            MOCK_CODEX_EXPECT_SANDBOX: 'workspace-write',
            MOCK_CODEX_HOME: dir,
            MOCK_CODEX_REJECT_HOOK_TRUST: '1',
            MOCK_CODEX_RPC_LOG: log,
          },
        },
        undefined,
        { autoEndAfterFirstTurn: true },
      );
      await expect(session.result).rejects.toThrow(/read-only hook trust grant failed.*mock trust store is read-only/);
      const methods = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line).method as string);
      expect(methods).toContain('config/batchWrite');
      expect(methods).not.toContain('turn/start');
    } finally {
      rmSync(dir, TEST_DIR_RM_OPTIONS);
    }
  }, 15_000);

  it('fails closed before any profile write when initialize reports a different CODEX_HOME', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xez-863-home-'));
    const requested = join(dir, 'requested');
    const reported = join(dir, 'wrapper-selected');
    const log = join(dir, 'rpc.ndjson');
    mkdirSync(requested);
    mkdirSync(reported);
    try {
      const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
        {
          userPrompt: 'review it',
          cwd: dir,
          allowedTools: REVIEW,
          bashAllowlist: ['git status'],
          env: { CODEX_HOME: requested, MOCK_CODEX_HOME: reported, MOCK_CODEX_RPC_LOG: log },
        },
        undefined,
        { autoEndAfterFirstTurn: true },
      );
      await expect(session.result).rejects.toThrow(/codex-home\.mismatch.*did not start the step or write hook trust/);
      const methods = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line).method as string);
      expect(methods).toEqual(['initialize', 'initialized']);
      expect(readFileSync(log, 'utf8')).not.toContain('config/batchWrite');
    } finally {
      rmSync(dir, TEST_DIR_RM_OPTIONS);
    }
  }, 15_000);

  it.each([
    ['read-only', REVIEW, ['git status']],
    ['writing', DEFAULT, undefined],
  ] as const)('compares a host-exported CODEX_HOME for a %s run', async (_name, allowedTools, bashAllowlist) => {
    const dir = mkdtempSync(join(tmpdir(), 'xez-863-host-home-'));
    const requested = join(dir, 'host-exported');
    const reported = join(dir, 'wrapper-selected');
    const log = join(dir, 'rpc.ndjson');
    mkdirSync(requested);
    mkdirSync(reported);
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = requested;
    try {
      const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
        {
          userPrompt: 'review it',
          cwd: dir,
          allowedTools,
          ...(bashAllowlist ? { bashAllowlist: [...bashAllowlist] } : {}),
          env: {
            MOCK_CODEX_HOME: reported,
            MOCK_CODEX_RPC_LOG: log,
            ...(bashAllowlist ? { MOCK_CODEX_EXPECT_SANDBOX: 'workspace-write' } : {}),
          },
        },
        undefined,
        { autoEndAfterFirstTurn: true },
      );
      await expect(session.result).rejects.toThrow(/codex-home\.mismatch.*did not start the step or write hook trust/);
      const methods = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line).method as string);
      expect(methods).toEqual(['initialize', 'initialized']);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      rmSync(dir, TEST_DIR_RM_OPTIONS);
    }
  }, 15_000);

  it('allows a writing run when CODEX_HOME is exported but initialize omits codexHome', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xez-863-writing-home-'));
    const requested = join(dir, 'host-exported');
    const log = join(dir, 'rpc.ndjson');
    mkdirSync(requested);
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = requested;
    try {
      const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
        {
          userPrompt: 'write it',
          cwd: dir,
          allowedTools: DEFAULT,
          env: { MOCK_CODEX_OMIT_HOME: '1', MOCK_CODEX_RPC_LOG: log },
        },
        undefined,
        { autoEndAfterFirstTurn: true },
      );
      await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' });
      const methods = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line).method as string);
      expect(methods).toContain('turn/start');
      expect(methods).not.toContain('config/batchWrite');
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      rmSync(dir, TEST_DIR_RM_OPTIONS);
    }
  }, 15_000);

  it('passes the locked-run marker and allowlist through Codex to the hook process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xez-863-hook-env-'));
    const hookLog = join(dir, 'hook.ndjson');
    try {
      const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
        {
          userPrompt: 'review it',
          cwd: dir,
          allowedTools: REVIEW,
          bashAllowlist: ['git status'],
          env: {
            MOCK_CODEX_EXPECT_SANDBOX: 'workspace-write',
            MOCK_CODEX_HOME: dir,
            MOCK_CODEX_HOOK_LOG: hookLog,
          },
        },
        undefined,
        { autoEndAfterFirstTurn: true },
      );
      await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' });
      const invocation = JSON.parse(readFileSync(hookLog, 'utf8').trim()) as {
        status: number;
        stdout: string;
        stderr: string;
      };
      expect(invocation).toMatchObject({ status: 0, stdout: '', stderr: '' });
      const hook = codexReadOnlyHook({ cwd: dir, userPrompt: '', allowedTools: REVIEW, bashAllowlist: ['git status'] });
      expect(readdirSync(join(dirname(hook!.script), 'locks'))).toEqual([]);
    } finally {
      rmSync(dir, TEST_DIR_RM_OPTIONS);
    }
  }, 15_000);

  it('accepts two CODEX_HOME spellings that resolve to the same directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xez-863-home-alias-'));
    const realHome = join(dir, 'real');
    const aliasHome = join(dir, 'alias');
    mkdirSync(realHome);
    linkDir(realHome, aliasHome);
    try {
      const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
        {
          userPrompt: 'review it',
          cwd: dir,
          allowedTools: REVIEW,
          bashAllowlist: ['git status'],
          env: {
            CODEX_HOME: aliasHome,
            MOCK_CODEX_HOME: realHome,
            MOCK_CODEX_EXPECT_SANDBOX: 'workspace-write',
          },
        },
        undefined,
        { autoEndAfterFirstTurn: true },
      );
      await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' });
    } finally {
      rmSync(dir, TEST_DIR_RM_OPTIONS);
    }
  }, 15_000);

  it('preserves existing user hooks and grants trust before the first turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xez-863-install-'));
    const log = join(dir, 'rpc.ndjson');
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({
      owner: 'user',
      hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'existing-hook' }] }] },
    }));
    try {
      const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
        {
          userPrompt: 'review it',
          cwd: dir,
          allowedTools: REVIEW,
          bashAllowlist: ['git status'],
          env: {
            MOCK_CODEX_EXPECT_SANDBOX: 'workspace-write',
            MOCK_CODEX_HOME: dir,
            MOCK_CODEX_RPC_LOG: log,
          },
        },
        undefined,
        { autoEndAfterFirstTurn: true },
      );
      await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' });
      const installed = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8')) as {
        owner: string;
        hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
      };
      expect(installed.owner).toBe('user');
      expect(installed.hooks.PreToolUse[0]?.hooks[0]?.command).toBe('existing-hook');
      expect(installed.hooks.PreToolUse.filter((entry) => entry.matcher === 'Bash|apply_patch')).toHaveLength(1);
      const command = installed.hooks.PreToolUse.find((entry) => entry.matcher === 'Bash|apply_patch')?.hooks[0]?.command;
      expect(command).toBeTypeOf('string');
      if (!command) throw new Error('installed Bash hook has no command');
      const script = command.match(/^'[^']+' '([^']+)' --xezar-read-only-hook$/)?.[1];
      expect(script).toMatch(new RegExp(`${cacheProject.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/]\\.local[\\\\/]xezar[\\\\/]cache[\\\\/]codex-hook[\\\\/][a-f0-9]{64}\\.mjs$`));
      if (!script) throw new Error('installed Bash hook command has no cache script path');
      expect(statSync(script).mode & 0o777).toBe(0o444);
      const methods = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line).method as string);
      expect(methods.indexOf('hooks/list')).toBeLessThan(methods.indexOf('config/batchWrite'));
      expect(methods.indexOf('config/batchWrite')).toBeLessThan(methods.indexOf('turn/start'));
    } finally {
      rmSync(dir, TEST_DIR_RM_OPTIONS);
    }
  }, 15_000);

  it('replaces the legacy Bash-only xezar entry before rediscovery and trust', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xez-863-matcher-migration-'));
    const log = join(dir, 'rpc.ndjson');
    const hook = codexReadOnlyHook({
      userPrompt: 'review it',
      cwd: dir,
      allowedTools: REVIEW,
      bashAllowlist: ['git status'],
    })!;
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hook.command }] }] },
    }));
    try {
      const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
        {
          userPrompt: 'review it',
          cwd: dir,
          allowedTools: REVIEW,
          bashAllowlist: ['git status'],
          env: {
            MOCK_CODEX_EXPECT_SANDBOX: 'workspace-write',
            MOCK_CODEX_HOME: dir,
            MOCK_CODEX_RPC_LOG: log,
          },
        },
        undefined,
        { autoEndAfterFirstTurn: true },
      );
      await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' });
      const installed = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8')) as {
        hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
      };
      expect(installed.hooks.PreToolUse).toEqual([{
        matcher: 'Bash|apply_patch',
        hooks: [{ type: 'command', command: hook.command }],
      }]);
      const methods = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line).method as string);
      expect(methods.indexOf('hooks/list')).toBeLessThan(methods.indexOf('config/batchWrite'));
      expect(methods.indexOf('config/batchWrite')).toBeLessThan(methods.indexOf('turn/start'));
    } finally {
      rmSync(dir, TEST_DIR_RM_OPTIONS);
    }
  }, 15_000);

  it.each([
    ['current then legacy', ['current', 'legacy']],
    ['legacy then current', ['legacy', 'current']],
    ['legacy with a different cache digest', ['legacy-different-digest']],
  ] as const)('keeps exactly one current xezar entry from %s', async (_name, entryKinds) => {
    const dir = mkdtempSync(join(tmpdir(), 'xez-863-matcher-dedupe-'));
    const hook = codexReadOnlyHook({
      userPrompt: 'review it',
      cwd: dir,
      allowedTools: REVIEW,
      bashAllowlist: ['git status'],
    })!;
    const currentScript = hook.command.match(/^'[^']+' '([^']+)' --xezar-read-only-hook$/)?.[1];
    if (!currentScript) throw new Error('current hook command has no cache script path');
    const differentDigestScript = join(dirname(currentScript), `${'0'.repeat(64)}.mjs`);
    if (entryKinds.some((kind) => kind === 'legacy-different-digest')) {
      mkdirSync(dirname(differentDigestScript), { recursive: true });
      writeFileSync(differentDigestScript, 'legacy xezar hook');
    }
    const legacyCommand = (kind: typeof entryKinds[number]): string => {
      if (kind !== 'legacy-different-digest') return hook.command;
      return `'${process.execPath}' '${differentDigestScript}' --xezar-read-only-hook`;
    };
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({
      hooks: {
        PreToolUse: entryKinds.map((kind) => ({
          matcher: kind === 'current' ? 'Bash|apply_patch' : 'Bash',
          hooks: [{ type: 'command', command: legacyCommand(kind) }],
        })),
      },
    }));
    try {
      const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
        {
          userPrompt: 'review it',
          cwd: dir,
          allowedTools: REVIEW,
          bashAllowlist: ['git status'],
          env: { MOCK_CODEX_EXPECT_SANDBOX: 'workspace-write', MOCK_CODEX_HOME: dir },
        },
        undefined,
        { autoEndAfterFirstTurn: true },
      );
      await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' });
      const installed = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8')) as {
        hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
      };
      expect(installed.hooks.PreToolUse).toEqual([{
        matcher: 'Bash|apply_patch',
        hooks: [{ type: 'command', command: hook.command }],
      }]);
    } finally {
      rmSync(dir, TEST_DIR_RM_OPTIONS);
    }
  }, 15_000);

  it('keeps two live xezar commands and prunes only the entry whose script is gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xez-863-prune-'));
    const live = join(dir, 'other-live.mjs');
    const missing = join(dir, 'other-missing.mjs');
    writeFileSync(live, '');
    const command = (script: string) => `'${process.execPath}' '${script}' --xezar-read-only-hook`;
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({
      hooks: { PreToolUse: [live, missing].map((script) => ({
        matcher: 'Bash',
        hooks: [{ type: 'command', command: command(script) }],
      })) },
    }));
    try {
      const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
        {
          userPrompt: 'review it',
          cwd: dir,
          allowedTools: REVIEW,
          bashAllowlist: ['git status'],
          env: { MOCK_CODEX_EXPECT_SANDBOX: 'workspace-write', MOCK_CODEX_HOME: dir },
        },
        undefined,
        { autoEndAfterFirstTurn: true },
      );
      await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' });
      const installed = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8')) as {
        hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
      };
      const commands = installed.hooks.PreToolUse.map((entry) => entry.hooks[0]?.command ?? '');
      expect(commands).toContain(command(live));
      expect(commands).not.toContain(command(missing));
      expect(commands).toHaveLength(2);
    } finally {
      rmSync(dir, TEST_DIR_RM_OPTIONS);
    }
  }, 15_000);

  // win32-skip(#973): creating a file symlink needs Developer Mode or elevation (EPERM)
  it.skipIf(!FILE_SYMLINKS)('refuses a symlinked hooks.json with a named reason and leaves its target untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xez-863-symlink-'));
    const target = join(dir, 'dotfiles-hooks.json');
    writeFileSync(target, '{"owner":"user"}\n');
    symlinkSync(target, join(dir, 'hooks.json'));
    try {
      const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
        {
          userPrompt: 'review it',
          cwd: dir,
          allowedTools: REVIEW,
          bashAllowlist: ['git status'],
          env: { MOCK_CODEX_EXPECT_SANDBOX: 'workspace-write', MOCK_CODEX_HOME: dir },
        },
        undefined,
        { autoEndAfterFirstTurn: true },
      );
      await expect(session.result).rejects.toThrow(/hooks-file\.symlink refused/);
      expect(readFileSync(target, 'utf8')).toBe('{"owner":"user"}\n');
    } finally {
      rmSync(dir, TEST_DIR_RM_OPTIONS);
    }
  }, 15_000);

  it('keeps danger-full-access and no workspace-write policy for the default writing list, on start and on resume', async () => {
    expect(await threadRequest({ allowedTools: DEFAULT, expect: 'danger-full-access' })).toEqual([
      { method: 'thread/start', params: { cwd: '<cwd>', sandbox: 'danger-full-access', approvalPolicy: 'never', config: noServers } },
    ]);
    expect(await threadRequest({ allowedTools: DEFAULT, expect: 'danger-full-access', resume: true })).toEqual([
      {
        method: 'thread/resume',
        params: { threadId: 'th_mock_1', excludeTurns: true, cwd: '<cwd>', sandbox: 'danger-full-access', approvalPolicy: 'never', config: noServers },
      },
    ]);
  }, 30_000);

  it('gives a writable root that is a link as the folder it leads to, once, so bubblewrap accepts it (#1080)', () => {
    const base = mkdtempSync(join(realpathSync(tmpdir()), 'xez-1080-'));
    try {
      const real = join(base, 'run-tmp');
      mkdirSync(real);
      const link = join(base, 'xez-short');
      linkDir(real, link);
      const evidence = join(base, 'evidence');
      expect(codexPermissions(REVIEW, [evidence, link, real], {}).workspaceWrite?.writable_roots).toEqual([evidence, real]);
    } finally {
      rmSync(base, TEST_DIR_RM_OPTIONS);
    }
  });

  it('picks the permissions from the one signal, with XEZ_CODEX_NETWORK=0 keeping precedence over network', () => {
    const roots = ['/r'];
    expect(codexPermissions(REVIEW, roots, {})).toEqual({
      sandbox: 'workspace-write',
      workspaceWrite: { network_access: true, writable_roots: ['/r'] },
    });
    expect(codexPermissions(REVIEW, roots, { XEZ_CODEX_NETWORK: '0' })).toEqual({
      sandbox: 'workspace-write',
      workspaceWrite: { network_access: false, writable_roots: ['/r'] },
    });
    expect(codexPermissions([], undefined, {})).toEqual({
      sandbox: 'workspace-write',
      workspaceWrite: { network_access: true, writable_roots: [] },
    });
    expect(codexPermissions(DEFAULT, roots, {})).toEqual({ sandbox: 'danger-full-access' });
    expect(codexPermissions(DEFAULT, roots, { XEZ_CODEX_NETWORK: '0' })).toEqual({ sandbox: 'workspace-write' });
    expect(codexPermissions(undefined, roots, {})).toEqual({ sandbox: 'danger-full-access' });
    expect(codexPermissions(['Read', 'Edit'], roots, {})).toEqual({ sandbox: 'danger-full-access' });
  });


  // #1009: Codex 0.157.1 on Windows downgrades workspace-write to read-only unless windows.sandbox
  // is set, and read-only under approvalPolicy never refuses every command.
  it('chooses the unelevated Windows sandbox for a workspace-write thread on win32 only', () => {
    expect(codexWindowsSandboxConfig('workspace-write', 'win32')).toEqual({ windows: { sandbox: 'unelevated' } });
    expect(codexWindowsSandboxConfig('danger-full-access', 'win32')).toEqual({});
    expect(codexWindowsSandboxConfig('workspace-write', 'linux')).toEqual({});
    expect(codexWindowsSandboxConfig('workspace-write', 'darwin')).toEqual({});
  });
});

/**
 * #895: a Codex app-server that dies under a live turn. The session used to wait for stdout to
 * end, so a tool process Codex had started, still holding the pipe, kept the turn "running" for as
 * long as it lived – and a cancel delivered nothing, because `interrupt()` only signals a child
 * that has not exited. An app-server that exited 0 mid-turn read as a finished turn.
 */
describe('an app-server that dies under a live turn (#895)', () => {
  const mockBin = fileURLToPath(
    new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url),
  );
  let dir: string;
  let pidFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xez-895-runner-'));
    pidFile = join(dir, 'orphan.pid');
  });

  afterEach(() => {
    // Stop only the grandchild the mock started for this test, by its own pid.
    try {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      if (pid > 0) process.kill(pid, 'SIGKILL');
    } catch {
      // never started, or already gone
    }
    rmSync(dir, TEST_DIR_RM_OPTIONS);
  });

  const startDying = (prompt: string, events: AgentEvent[]) =>
    new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
      { userPrompt: prompt, cwd: dir, env: { MOCK_CODEX_ORPHAN_PID_FILE: pidFile } },
      (event) => events.push(event),
    );

  const exited = (pid: number | undefined) => {
    try {
      process.kill(pid!, 0);
      return false;
    } catch {
      return true;
    }
  };

  it('fails the turn instead of finishing it when the app-server exits 0 mid-turn', async () => {
    const events: AgentEvent[] = [];
    const session = startDying('mock:exit-mid-turn', events);

    await expect(session.result).rejects.toThrow(/codex app-server exited before the turn finished/);
    expect(events.some((e) => e.type === 'error' && e.message.includes('before the turn finished'))).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  }, 15_000);

  it('settles at once when cancelled after the app-server died with its pipe still held open', async () => {
    const events: AgentEvent[] = [];
    const session = startDying('mock:exit-mid-turn-orphan', events);
    const settled = session.result.then(() => 'resolved', (err: Error) => err.message);
    await expect.poll(() => exited(session.pid), { timeout: 10_000 }).toBe(true);
    // The orphan really holds the pipe: the read loop is still open.
    const early = await Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve('open'), 300))]);
    expect(early).toBe('open');

    const cancelledAt = Date.now();
    session.interrupt();

    // A cancel is xezar's own stop: the session settles, and promptly – well inside the grace a
    // dead app-server's pipe gets on its own.
    expect(await settled).toBe('resolved');
    expect(Date.now() - cancelledAt).toBeLessThan(KILL_GRACE_MS);
  }, 20_000);
});

describe('a dead app-server whose stdout never ends (#895)', () => {
  it('stops reading KILL_GRACE_MS after the exit and fails the unfinished session', async () => {
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      pid: 4895,
      kill: () => true,
    }) as unknown as ChildProcessWithoutNullStreams;
    spawnHook.override = () => child;
    vi.useFakeTimers();
    try {
      const session = new CodexAppServerRunner({ bin: 'codex', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      let state: string | undefined;
      const settled = session.result.then(() => 'resolved', (err: Error) => err.message);
      void settled.then((s) => {
        state = s;
      });
      // Exits before answering `initialize`; stdout stays open, as a grandchild would keep it.
      Object.assign(child, { exitCode: 0 });
      emitter.emit('exit', 0, null);

      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS - 1);
      expect(state).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      expect(await settled).toMatch(/codex app-server exited before it answered/);
    } finally {
      vi.useRealTimers();
      spawnHook.override = null;
    }
  });
});
