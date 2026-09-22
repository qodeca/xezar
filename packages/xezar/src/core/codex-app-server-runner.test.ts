import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-runner.js';
import { KILL_GRACE_MS } from './claude-cli-runner.js';
import { CodexAppServerRunner, codexPermissions } from './codex-app-server-runner.js';

/** Only the escalation tests below swap the child out; every other test in this
 *  file keeps spawning the real mock app-server through the untouched `spawn`. */
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
    expect(
      events.some((e) => e.type === 'note' && e.message.includes('terminated by xezar (code 143)')),
    ).toBe(true);
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
  const mockBin = fileURLToPath(
    new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url),
  );

  it.skipIf(process.platform === 'win32')(
    'keeps the SIGKILL escalation armed until the child exits',
    async () => {
      const events: AgentEvent[] = [];
      const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 100 }).startSession(
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
            setTimeout(() => reject(new Error('session stayed pending after the SIGKILL grace period')), 13_000),
          ),
        ]);

        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(KILL_GRACE_MS - 500);
        expect(result.text).toBe('Checking the working tree.');
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
    15_000,
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
  };

  async function threadRequest(opts: { allowedTools: string[]; expect: string; resume?: boolean }) {
    const dir = mkdtempSync(join(tmpdir(), 'xez-849-'));
    const log = join(dir, 'thread.ndjson');
    try {
      const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
      const session = runner.startSession(
        {
          userPrompt: 'review it',
          cwd: dir,
          allowedTools: opts.allowedTools,
          additionalDirectories: ROOTS,
          ...(opts.resume ? { resume: true, sessionId: 'th_mock_1' } : {}),
          env: { MOCK_CODEX_EXPECT_SANDBOX: opts.expect, MOCK_CODEX_THREAD_LOG: log },
        },
        undefined,
        { autoEndAfterFirstTurn: true },
      );
      await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' });
      // `cwd` is the run's own temp dir; swap it for a stable token so the params pin whole.
      return readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line.split(dir).join('<cwd>')) as unknown);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
        params: { threadId: 'th_mock_1', cwd: '<cwd>', sandbox: 'workspace-write', approvalPolicy: 'never', config: confined },
      },
    ]);
  }, 15_000);

  it('keeps danger-full-access and no workspace-write policy for the default writing list, on start and on resume', async () => {
    expect(await threadRequest({ allowedTools: DEFAULT, expect: 'danger-full-access' })).toEqual([
      { method: 'thread/start', params: { cwd: '<cwd>', sandbox: 'danger-full-access', approvalPolicy: 'never', config: noServers } },
    ]);
    expect(await threadRequest({ allowedTools: DEFAULT, expect: 'danger-full-access', resume: true })).toEqual([
      {
        method: 'thread/resume',
        params: { threadId: 'th_mock_1', cwd: '<cwd>', sandbox: 'danger-full-access', approvalPolicy: 'never', config: noServers },
      },
    ]);
  }, 30_000);

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
});
