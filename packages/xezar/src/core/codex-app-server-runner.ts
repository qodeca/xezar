import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentEvent,
  AgentRunResult,
  AgentRunSpec,
  AgentRunner,
  AgentSession,
  AgentToolCallRecord,
  ContentBlock,
  SessionOptions,
} from './agent-runner.ts';
import {
  foreignSignalExitMessage,
  isSignalTerminationExit,
  prependSystemPrompt,
  trackChildExit,
} from './agent-runner.ts';
import {
  AUTO_END_DELAY_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  KILL_GRACE_MS,
} from './claude-cli-runner.ts';
import { CODEX_READ_ONLY_ALLOWLIST_ENV } from './codex-read-only-hook.ts';
import { acquireFileLock, queueByLockPath } from './file-lock.ts';
import { isReadOnlyStep, normalizeBashAllowlist } from './read-only-lock.ts';
import { parseAskRequest, type AskQuestion } from './ask.ts';
import { readNdjson } from './ndjson.ts';
import { V1TextCoalescer } from './v1-text-coalescer.ts';
import {
  CodexAppServerRpc,
  codexSpawnError,
  endCodexAppServer,
  resolveCodexExecutable,
  spawnCodexAppServer,
  type CodexAppServerMessage,
  waitForCodexAppServerExit,
} from './codex-app-server-transport.ts';
import { codexIsolationNote, codexRunIsolation, type CodexRunIsolation } from './codex-run-isolation.ts';
import {
  codexSessionStarted,
  createCodexUiState,
  mapCodexNotification,
  type CodexUiMapping,
  type CodexUiMapperState,
} from './codex-ui-mapper.ts';

export interface CodexRunnerOptions {
  /** Override the binary name/path; defaults to `codex` on PATH. */
  bin?: string;
  /** Wall-clock timeout for a run (ms); per-spec `timeoutMs` still wins. */
  timeoutMs?: number;
}

/**
 * `AgentRunner` over `codex app-server` — the same JSONL transport the VS Code
 * extension and desktop app use (JSON-RPC 2.0, newline-delimited, over
 * stdin/stdout). One long-lived process per session gives Codex the same
 * multi-turn shape as the Claude runner: `turn/start` for a new turn,
 * `turn/steer` for a mid-turn follow-up, `turn/interrupt` to cancel, and
 * `thread/resume` to reopen a stored thread for "Continue".
 *
 * Auth = the host's logged-in ChatGPT/Codex session (or CODEX_API_KEY). The
 * agent runs autonomously via `sandbox: danger-full-access` +
 * `approvalPolicy: never`, matching xezar's default auto permission mode
 * (spec 2026-07-17-permission-modes). `XEZ_CODEX_NETWORK=0` retains the previous
 * network-blocked `workspace-write` sandbox as an explicit restriction.
 *
 * What IS honoured from `spec.allowedTools` (#849): one signal, `isReadOnlyStep` —
 * a list naming neither `Edit` nor `Write` starts AND resumes the thread CONFINED:
 * `sandbox: workspace-write` with `sandbox_workspace_write` set through the thread's
 * `config` override to network on and the run's own roots (`spec.additionalDirectories`:
 * the evidence dir, handoff file dir and per-run TMPDIR) as the only writable paths
 * besides the worktree. That covers Codex's own file edits and the shell it runs.
 * Not `read-only`: that sandbox also drops all network and every write outside the
 * worktree, so a review or QA step could read a diff and then not post, label or
 * record its verdict (#850 review). Nothing finer either: Codex has no per-tool
 * allowlist. When a read-only step also declares `spec.bashAllowlist`, a trusted
 * PreToolUse hook applies the shared command lock before each Bash call. The individual
 * non-shell tool names remain ignored, the worktree itself stays writable, and the sandbox
 * does not cover MCP tools — what a
 * run may reach there is the per-thread MCP scoping of `codex-run-isolation.ts`
 * (#324), which applies to every run, read-only or not.
 */
/** The workspace-write policy a confined read-only step carries in its `config` override. */
export interface CodexWorkspaceWrite {
  network_access: boolean;
  writable_roots: string[];
}

/**
 * The thread's sandbox, and the workspace-write policy that goes with it. A read-only step (#849)
 * is confined: `workspace-write` with network on and the run's own directories writable, unless
 * XEZ_CODEX_NETWORK=0, which keeps precedence and turns its network off too. Every other step keeps
 * what it had: full access is the `auto` preset shared by all backends — besides avoiding prompts,
 * it keeps container installs working when bubblewrap cannot create a UID map (#563) — and
 * XEZ_CODEX_NETWORK=0 remains the backwards-compatible explicit `workspace-write` opt-out.
 */
export function codexPermissions(
  allowedTools: readonly string[] | undefined,
  additionalDirectories: readonly string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { sandbox: 'workspace-write' | 'danger-full-access'; workspaceWrite?: CodexWorkspaceWrite } {
  const networkOff = env.XEZ_CODEX_NETWORK === '0';
  if (isReadOnlyStep(allowedTools)) {
    return {
      sandbox: 'workspace-write',
      workspaceWrite: { network_access: !networkOff, writable_roots: [...(additionalDirectories ?? [])] },
    };
  }
  return { sandbox: networkOff ? 'workspace-write' : 'danger-full-access' };
}

export interface CodexReadOnlyHook {
  readonly command: string;
  readonly config: {
    readonly PreToolUse: readonly [{
      readonly matcher: 'Bash';
      readonly hooks: readonly [{ readonly type: 'command'; readonly command: string }];
    }];
  };
  readonly entries: string[];
}

/**
 * The vendor-specific registration only. Codex ignores request-body hooks until their content
 * hash is in its trust store, so bootstrap discovers and grants this exact handler before turn 1.
 */
export function codexReadOnlyHook(spec: AgentRunSpec): CodexReadOnlyHook | undefined {
  if (!isReadOnlyStep(spec.allowedTools) || spec.bashAllowlist === undefined) return undefined;
  const script = fileURLToPath(new URL('../../scripts/codex-read-only-hook.mjs', import.meta.url));
  const command = `${shellQuote(process.execPath)} ${shellQuote(script)} --xezar-read-only-hook`;
  return {
    command,
    config: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }],
    },
    entries: normalizeBashAllowlist(spec.bashAllowlist),
  };
}

export class CodexAppServerRunner implements AgentRunner {
  readonly backend = 'codex' as const;

  private readonly bin: string;
  private readonly timeoutMs: number;
  private lastSession: CodexSession | null = null;

  constructor(opts: CodexRunnerOptions = {}) {
    this.bin = resolveCodexExecutable(opts.bin);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  }

  /** What a spec with no `timeoutMs` falls through to here (#460) — the same field the session
   *  reads, so a reported deadline and the one that actually kills cannot drift apart. */
  get defaultTimeoutMs(): number {
    return this.timeoutMs;
  }

  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }

  async interrupt(): Promise<void> {
    this.lastSession?.interrupt();
  }

  startSession(
    spec: AgentRunSpec,
    onEvent?: (event: AgentEvent) => void,
    opts: SessionOptions = {},
  ): AgentSession {
    const session = new CodexSession(this.bin, this.timeoutMs, spec, onEvent, opts);
    this.lastSession = session;
    return session;
  }
}

interface PendingUserInput {
  readonly rpcId: number | string;
  readonly questions: AskQuestion[];
}

/** One live `codex app-server` process driving a single thread. */
class CodexSession implements AgentSession {
  readonly result: Promise<AgentRunResult>;

  private readonly child!: ChildProcessWithoutNullStreams;
  private readonly rpc!: CodexAppServerRpc;
  private stdinOpen = true;
  private threadId: string | undefined;
  private activeTurnId: string | undefined;
  private pendingUserInput: PendingUserInput | undefined;
  private readonly toolCalls: AgentToolCallRecord[] = [];
  private readonly textChunks: string[] = [];
  /** Streamed agentMessage deltas buffered per item — v1 `text` is emitted
   *  once per completed item (claude parity: one event per complete block),
   *  never per delta, so the persisted transcript and the headless CLI get
   *  whole paragraphs. Streaming display rides protocol v2's `item.delta`. */
  private readonly textCoalescer = new V1TextCoalescer((text) => {
    this.textChunks.push(text);
    this.emit({ type: 'text', text });
  });
  private tokensUsed = 0;
  private ready!: Promise<void>;
  private autoEndTimer: NodeJS.Timeout | undefined;
  private eofTermTimer: NodeJS.Timeout | undefined;
  private eofKillTimer: NodeJS.Timeout | undefined;
  private spawnFailed: Error | null = null;
  private timedOut = false;
  /** Set the moment WE signal the child (EOF watchdog, cancel, kill switch).
   *  codex handles the signal and exits 143, so without this the runner reads
   *  its own teardown as a codex failure (#703). */
  private terminatedByXezar = false;
  /** "Has the app-server really terminated?" — the question `child.killed`
   *  does not answer: it flips on signal delivery, so the SIGTERM this runner
   *  sends would otherwise veto its own SIGKILL escalation (#844). */
  private readonly hasExited: () => boolean;
  /** Protocol v2 emission — additive alongside v1 (`onEvent` keeps flowing
   *  byte-identical); the channel is `opts.onUiEvent` (RunManager wiring
   *  lands in R2 step 2.1). */
  private uiState: CodexUiMapperState = createCodexUiState();

  constructor(
    private readonly bin: string,
    timeoutMs: number,
    private readonly spec: AgentRunSpec,
    private readonly onEvent: ((event: AgentEvent) => void) | undefined,
    private readonly opts: SessionOptions,
  ) {
    const hook = codexReadOnlyHook(spec);
    try {
      this.child = spawnCodexAppServer(
        bin,
        spec.cwd,
        hook
          ? { ...spec.env, [CODEX_READ_ONLY_ALLOWLIST_ENV]: JSON.stringify(hook.entries) }
          : spec.env,
      );
      this.rpc = new CodexAppServerRpc(this.child);
    } catch (err) {
      throw codexSpawnError(err, bin);
    }

    this.hasExited = trackChildExit(this.child);
    this.child.on('error', (err: NodeJS.ErrnoException) => {
      this.spawnFailed = codexSpawnError(err, bin);
    });
    const stderrChunks: string[] = [];
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk));

    // Optional wall-clock kill switch (disabled for interactive sessions).
    const limitMs = spec.timeoutMs ?? timeoutMs;
    let killTimer: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    if (limitMs > 0) {
      deadline = setTimeout(() => {
        this.timedOut = true;
        this.interrupt();
        this.child.stdout.destroy();
        killTimer = setTimeout(() => {
          if (!this.hasExited()) {
            this.terminatedByXezar = true;
            this.child.kill('SIGKILL');
          }
        }, KILL_GRACE_MS);
        killTimer.unref?.();
      }, limitMs);
      deadline.unref?.();
    }

    // Handshake → thread → first turn. Kicked off concurrently with the read
    // loop below (which resolves the request() promises this awaits).
    this.ready = this.bootstrap();

    this.result = (async (): Promise<AgentRunResult> => {
      let sessionError: unknown;
      try {
        const readLoop = async () => {
          for await (const line of readNdjson(this.child.stdout)) {
            if (this.timedOut) break;
            let msg: CodexAppServerMessage;
            try {
              msg = JSON.parse(line) as CodexAppServerMessage;
            } catch {
              continue; // not JSON-RPC — skip
            }
            // A sub-agent child thread's turn lifecycle must reach neither channel (#600):
            // v1 would emit a bogus `turn-end`, and the v2 mapper — which carries no thread
            // identity — would record the child turn as the parent's, clearing its turn-scoped
            // plan/reasoning state and resetting the current turn id. Child ITEM events still
            // flow, so nested sub-agent activity keeps rendering.
            if (this.isForeignTurnLifecycle(msg)) continue;
            this.emitUi((state) => mapCodexNotification(msg, state));
            this.dispatch(msg);
          }
        };
        // Start consuming stdout before awaiting bootstrap: JSON-RPC responses
        // read here settle the initialize/thread/turn requests. Owning both
        // promises makes every bootstrap rejection part of session.result.
        await Promise.all([this.ready, readLoop()]);
      } catch (err) {
        if (!this.timedOut) {
          sessionError = err;
          // Bootstrap failed before a usable turn exists. Closing stdin lets
          // app-server exit normally; end() also owns the TERM/KILL watchdog
          // if a broken child ignores EOF.
          this.end();
        }
      } finally {
        if (deadline) clearTimeout(deadline);
        if (this.autoEndTimer) clearTimeout(this.autoEndTimer);
        this.stdinOpen = false;
      }

      // Destroying stdout ends the read loop before the timeout escalation's
      // grace period. Keep that escalation armed until the child is gone.
      const exitCode = await waitForCodexAppServerExit(this.child);
      if (killTimer) clearTimeout(killTimer);
      if (this.eofTermTimer) clearTimeout(this.eofTermTimer);
      if (this.eofKillTimer) clearTimeout(this.eofKillTimer);
      this.rpc.rejectPending();

      if (this.spawnFailed) throw this.spawnFailed;
      if (sessionError) throw sessionError;

      // Timeout/interrupt can end the read loop mid-item — recover buffered prose.
      this.textCoalescer.flush();
      const text = this.textChunks.join('\n').trim();
      const base: AgentRunResult = {
        text,
        toolCalls: this.toolCalls,
        tokensUsed: this.tokensUsed,
        sessionId: this.threadId ?? spec.sessionId,
      };

      if (this.timedOut) {
        const mins = Math.round((limitMs / 60_000) * 10) / 10;
        this.emit({ type: 'error', message: `codex app-server timed out after ${mins}m and was killed` });
        this.emit({ type: 'done' });
        return base;
      }

      // Our own EOF watchdog / cancel signal coming back as 143/137 — the
      // teardown xezar asked for, not a codex failure (#703).
      if (this.terminatedByXezar && isSignalTerminationExit(exitCode)) {
        this.emit({
          type: 'note',
          message: `codex app-server did not exit on its own after close; terminated by xezar (code ${exitCode})`,
        });
        this.emit({ type: 'done' });
        return base;
      }

      if (exitCode !== 0 && exitCode !== null) {
        const stderr = stderrChunks.join('').trim();
        const detail = stderr ? ` — ${stderr.split('\n').slice(-3).join(' | ')}` : '';
        // Same split as the claude runner (#156): a 128+signal code that got
        // past the flag above was signalled by something other than xezar.
        const message = isSignalTerminationExit(exitCode)
          ? `${foreignSignalExitMessage('codex app-server', exitCode)}${detail}`
          : `codex app-server exited with code ${exitCode}${detail}`;
        this.emit({ type: 'error', message });
        throw new Error(message);
      }

      this.emit({ type: 'done' });
      return base;
    })();
  }

  get open(): boolean {
    return this.stdinOpen;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  sendMessage(content: ContentBlock[]): boolean {
    if (!this.stdinOpen) return false;
    if (this.autoEndTimer) {
      clearTimeout(this.autoEndTimer);
      this.autoEndTimer = undefined;
    }
    const text = textOf(content);
    if (!text) return true;
    if (this.pendingUserInput) {
      const pending = this.pendingUserInput;
      this.pendingUserInput = undefined;
      this.rpc.respond({ id: pending.rpcId, result: { answers: userInputAnswers(pending.questions, text) } });
      return true;
    }
    // Wait for the thread to exist, then steer the live turn or start a new one.
    void this.ready
      .then(() => this.startOrSteerTurn(text))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.emit({ type: 'note', message: `codex: turn failed: ${message}` });
      });
    return true;
  }

  end(): void {
    if (!this.stdinOpen) return;
    this.rejectPendingUserInput('session ended');
    this.stdinOpen = false;
    try {
      endCodexAppServer(
        this.child,
        (term, kill) => {
          this.eofTermTimer = term;
          this.eofKillTimer = kill;
        },
        () => {
          this.terminatedByXezar = true;
        },
      );
    } catch {
      // already gone
    }
  }

  interrupt(): void {
    this.stdinOpen = false;
    this.rejectPendingUserInput('turn interrupted');
    // Best-effort graceful cancel of the in-flight turn, then hard stop.
    if (this.threadId && this.activeTurnId) {
      void this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.activeTurnId }).catch(
        () => undefined,
      );
    }
    if (!this.hasExited()) {
      this.terminatedByXezar = true;
      this.child.kill('SIGTERM');
    }
  }

  // ---- protocol -----------------------------------------------------------

  private async bootstrap(): Promise<void> {
    const initialized = await this.rpc.initialize();
    const isolation = await this.readIsolation();

    // `codexPermissions` owns the choice; start and resume both carry it (#849).
    const permissions = codexPermissions(this.spec.allowedTools, this.spec.additionalDirectories);
    const hook = codexReadOnlyHook(this.spec);
    if (hook) {
      const codexHome = stringField(initialized, 'codexHome');
      if (!codexHome) {
        throw new Error(
          'Codex read-only hook installation failed (initialize returned no codexHome); ' +
          'xezar did not start the step because its bashAllowlist could not be enforced.',
        );
      }
      try {
        await ensureCodexReadOnlyHookFile(codexHome, hook);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Codex read-only hook installation failed (${reason}); xezar did not start the step because its bashAllowlist could not be enforced.`,
        );
      }
    }
    const config = {
      ...isolation.config,
      ...(permissions.workspaceWrite ? { sandbox_workspace_write: permissions.workspaceWrite } : {}),
      ...(hook ? { hooks: hook.config } : {}),
    };
    const overrides = {
      model: this.spec.model,
      cwd: this.spec.cwd,
      sandbox: permissions.sandbox,
      approvalPolicy: 'never',
      // Only the project's own MCP servers; no home-config server, plugin, app or leader bridge
      // (#324, #323). Resume carries it too: a stored thread reloads its servers on reopen. A
      // confined read-only step adds its workspace-write policy to the same override.
      config,
    };
    if (this.spec.resume && this.spec.sessionId) {
      await this.rpc.request('thread/resume', { threadId: this.spec.sessionId, ...clean(overrides) });
      this.threadId = this.spec.sessionId;
    } else {
      const res = await this.rpc.request('thread/start', clean(overrides));
      this.threadId = threadIdOf(res) ?? this.spec.sessionId;
    }
    if (hook) await this.trustReadOnlyHook(hook);
    if (this.threadId) {
      this.emit({ type: 'session', sessionId: this.threadId });
      // The result path (thread/start response, or thread/resume which sends
      // no thread/started notification) — deduplicated inside the mapper.
      const threadId = this.threadId;
      this.emitUi((state) => codexSessionStarted(threadId, state));
    }
    const note = codexIsolationNote(isolation);
    if (note) this.emit({ type: 'note', message: note });

    // Seed the first turn. The system prompt (skill body + handoff contract)
    // has no dedicated app-server field, so it rides along as a leading block
    // of the opening message.
    const first = prependSystemPrompt(this.spec.systemPrompt, this.spec.userPrompt);
    await this.startOrSteerTurn(first);
  }

  /**
   * Codex owns the normalized hook hash; xezar must ask for it rather than hashing hooks JSON.
   * The grant is scoped by Codex's handler key and current hash in the active profile's
   * `config.toml`. Any discovery/write/verification gap fails before `turn/start`.
   */
  private async trustReadOnlyHook(hook: CodexReadOnlyHook): Promise<void> {
    try {
      const before = await this.rpc.request('hooks/list', { cwds: [this.spec.cwd] });
      const metadata = findCodexHook(before, hook.command);
      if (!metadata) throw new Error('hooks/list did not discover the registered Bash handler');
      if (!metadata.key || !metadata.currentHash) {
        throw new Error('hooks/list returned no handler key or current hash');
      }
      const grant = await this.rpc.request('config/batchWrite', {
        edits: [{
          keyPath: `hooks.state.${JSON.stringify(metadata.key)}.trusted_hash`,
          mergeStrategy: 'upsert',
          value: metadata.currentHash,
        }],
        reloadUserConfig: true,
      });
      if (grant.status !== 'ok') throw new Error(`config/batchWrite returned status ${JSON.stringify(grant.status)}`);
      const after = findCodexHook(
        await this.rpc.request('hooks/list', { cwds: [this.spec.cwd] }),
        hook.command,
      );
      if (after?.trustStatus !== 'trusted' && after?.trustStatus !== 'managed') {
        throw new Error(`hooks/list reported trust status ${JSON.stringify(after?.trustStatus ?? 'missing')}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Codex read-only hook trust grant failed (${reason}); xezar did not start the step because its bashAllowlist could not be enforced.`,
      );
    }
  }

  /**
   * Ask THIS app-server which MCP servers it would load for the run's cwd — the only answer that
   * reflects the home it really uses — and derive the thread's isolation from it. A Codex that
   * cannot answer fails the run closed: starting the thread anyway would hand the model every
   * server the person configured for their own use (#324).
   */
  private async readIsolation(): Promise<CodexRunIsolation> {
    try {
      return codexRunIsolation(await this.rpc.request('config/read', { cwd: this.spec.cwd, includeLayers: false }));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `codex app-server could not list the MCP servers it would load (${reason}). xezar does not start a ` +
          `Codex run that could reach servers from your own Codex config; update the Codex CLI (npm i -g @openai/codex).`,
      );
    }
  }

  private async startOrSteerTurn(text: string): Promise<void> {
    if (!this.threadId) return;
    const input = [{ type: 'text', text, text_elements: [] }];
    if (this.activeTurnId) {
      await this.rpc.request('turn/steer', {
        threadId: this.threadId,
        input,
        expectedTurnId: this.activeTurnId,
      });
      return;
    }
    // Ask the app-server for reasoning summaries; without this the model runs
    // with its default (no summary), so the reasoning thread stays empty even
    // though the mapper and UI can render it. The override persists for this
    // turn and every subsequent turn, so seeding it on turn/start is enough.
    const res = await this.rpc.request('turn/start', {
      threadId: this.threadId,
      input,
      summary: reasoningSummary(),
    });
    this.activeTurnId = turnIdOf(res) ?? this.activeTurnId;
  }

  private dispatch(msg: CodexAppServerMessage): void {
    if (this.rpc.dispatchResponse(msg)) return;
    if (msg.method === 'item/tool/requestUserInput' && (typeof msg.id === 'number' || typeof msg.id === 'string')) {
      this.handleUserInputRequest(msg.id, msg.params ?? {});
      return;
    }
    if (typeof msg.method === 'string') this.handleNotification(msg.method, msg.params ?? {});
  }

  private handleUserInputRequest(rpcId: number | string, params: Record<string, unknown>): void {
    const questions = codexAskQuestions(params.questions);
    if (!questions) {
      this.rpc.respond({ id: rpcId, error: { code: -32602, message: 'unsupported or malformed requestUserInput payload' } });
      return;
    }
    if (this.pendingUserInput) this.rejectPendingUserInput('superseded by a newer requestUserInput');
    this.pendingUserInput = { rpcId, questions };
    this.opts.onUiEvent?.({ type: 'ask.requested', requestId: `codex-${String(rpcId)}`, questions });
  }

  private rejectPendingUserInput(message: string): void {
    const pending = this.pendingUserInput;
    if (!pending) return;
    this.pendingUserInput = undefined;
    this.rpc.respond({ id: pending.rpcId, error: { code: -32000, message } });
  }

  /** True when a turn notification belongs to a sub-agent CHILD thread rather than this run's
   *  own main thread — its lifecycle must not start or end the parent turn (#600). The app-server
   *  multiplexes every thread over one connection, so a spawned skill's child `turn/completed`
   *  would otherwise emit a `turn-end` and park the actively-working run under "Needs you".
   *  Fail-open: an absent `threadId` (the single-thread wire shape) or our own id counts as ours. */
  private isForeignThreadTurn(params: Record<string, unknown>): boolean {
    const eventThreadId = stringField(params, 'threadId');
    return !!eventThreadId && !!this.threadId && eventThreadId !== this.threadId;
  }

  /** A `turn/started|completed|failed` notification for a sub-agent child thread — dropped
   *  before either channel processes it (#600). Only turn lifecycle is filtered; child item
   *  events still map, so nested sub-agent activity keeps rendering. */
  private isForeignTurnLifecycle(msg: CodexAppServerMessage): boolean {
    const method = typeof msg.method === 'string' ? msg.method : undefined;
    if (!method || !TURN_LIFECYCLE_METHODS.has(method)) return false;
    return this.isForeignThreadTurn((msg.params ?? {}) as Record<string, unknown>);
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'turn/started': {
        if (this.isForeignThreadTurn(params)) break; // sub-agent child thread — not our turn (#600)
        this.activeTurnId = turnIdOf(params) ?? this.activeTurnId;
        break;
      }
      case 'item/agentMessage/delta': {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (delta) this.textCoalescer.append(stringField(params, 'itemId'), delta);
        break;
      }
      case 'item/started': {
        const item = (params.item as Record<string, unknown>) ?? {};
        const type = stringField(item, 'type');
        // Only tool-like items become tool events; message/reasoning stream as text.
        if (type && !NON_TOOL_ITEMS.has(type)) {
          const id = stringField(item, 'id') ?? `item-${this.rpc.allocateId()}`;
          this.toolCalls.push({ id, name: type, input: item });
          this.emit({ type: 'tool-call', id, tool: type, input: item });
        }
        break;
      }
      case 'item/completed': {
        const item = (params.item as Record<string, unknown>) ?? {};
        const type = stringField(item, 'type');
        const id = stringField(item, 'id') ?? '';
        if (type === 'agentMessage') {
          // One v1 `text` per finished message — the snapshot's full text when
          // present (also covers turns that send no deltas), else the deltas.
          this.textCoalescer.complete(id || undefined, typeof item.text === 'string' ? item.text : undefined);
        } else if (type && !NON_TOOL_ITEMS.has(type) && id) {
          this.emit({
            type: 'tool-result',
            toolCallId: id,
            result: safeStringify(item),
            isError: /error|failed/i.test(stringField(item, 'status') ?? ''),
          });
        }
        break;
      }
      case 'thread/tokenUsage/updated': {
        const total = tokenTotal(params);
        if (total > 0) {
          this.tokensUsed = total;
          this.emit({ type: 'token-usage', tokensUsed: this.tokensUsed });
        }
        break;
      }
      case 'turn/completed':
      case 'turn/failed': {
        if (this.isForeignThreadTurn(params)) break; // don't end the parent turn on a child turn (#600)
        this.pendingUserInput = undefined;
        this.activeTurnId = undefined;
        // An interrupted/failed item never sees item/completed — surface its
        // partial prose before the turn boundary (run.ts reads markers there).
        this.textCoalescer.flush();
        if (method === 'turn/failed' && !this.terminatedByXezar) {
          const error = params.error as Record<string, unknown> | undefined;
          const message = stringField(error ?? {}, 'message') ?? 'codex turn failed';
          this.emit({ type: 'error', message });
        }
        this.emit({ type: 'turn-end' });
        if (this.opts.autoEndAfterFirstTurn && this.stdinOpen && !this.autoEndTimer) {
          this.autoEndTimer = setTimeout(() => this.end(), AUTO_END_DELAY_MS);
          this.autoEndTimer.unref?.();
        }
        break;
      }
      default:
        break;
    }
  }

  private emit(event: AgentEvent): void {
    this.onEvent?.(event);
  }

  /** The mapper never throws, but a defect in it must still never disturb
   *  the v1 stream — hence the belt-and-braces try. */
  private emitUi(map: (state: CodexUiMapperState) => CodexUiMapping): void {
    try {
      const mapped = map(this.uiState);
      this.uiState = mapped.state;
      if (this.opts.onUiEvent) {
        for (const event of mapped.events) this.opts.onUiEvent(event);
      }
    } catch {
      // v2 mapping is best-effort; v1 consumers stay unaffected.
    }
  }
}

// ---- helpers --------------------------------------------------------------

interface CodexHookMetadata {
  readonly key?: string;
  readonly command?: string;
  readonly matcher?: string;
  readonly currentHash?: string;
  readonly trustStatus?: string;
  readonly enabled?: boolean;
}

interface CodexHooksFile {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Codex 0.155.1 does not discover hooks supplied only in `thread/start`/`thread/resume` config.
 * Install the same handler in the active profile's user-layer hooks.json, the thinnest unavoidable
 * vendor adapter proven by #863 S0b/S0c. The handler is inert outside a xezar-spawned process
 * because its allowlist lives only in that process environment.
 */
async function ensureCodexReadOnlyHookFile(codexHome: string, hook: CodexReadOnlyHook): Promise<void> {
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const path = join(codexHome, 'hooks.json');
  const lockPath = `${path}.lock`;
  await queueByLockPath(lockPath, async () => {
    const acquisition = await acquireFileLock(lockPath, { waitMs: 5_000 });
    if (!acquisition.acquired) throw new Error(`could not lock ${path} for hook registration`);
    try {
      let document: CodexHooksFile = {};
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('the file root is not an object');
        }
        document = parsed as CodexHooksFile;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`could not read ${path} without losing existing hooks (${reason})`);
        }
      }
      const hooks = document.hooks && typeof document.hooks === 'object' && !Array.isArray(document.hooks)
        ? document.hooks
        : {};
      if (document.hooks !== undefined && hooks !== document.hooks) {
        throw new Error(`could not update ${path} because "hooks" is not an object`);
      }
      const existing = hooks.PreToolUse;
      if (existing !== undefined && !Array.isArray(existing)) {
        throw new Error(`could not update ${path} because hooks.PreToolUse is not an array`);
      }
      const installed = (existing ?? []).filter((entry) => isXezarCodexHookEntry(entry));
      if (installed.length === 1 && hookEntryCommands(installed[0]).includes(hook.command)) return;
      const handlers = (existing ?? []).filter((entry) => !isXezarCodexHookEntry(entry));
      handlers.push({ matcher: 'Bash', hooks: [{ type: 'command', command: hook.command }] });
      const next = { ...document, hooks: { ...hooks, PreToolUse: handlers } };
      const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    } finally {
      await acquisition.release();
    }
  });
}

function isXezarCodexHookEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || (entry as { matcher?: unknown }).matcher !== 'Bash') return false;
  const commands = hookEntryCommands(entry);
  return commands.length === 1 &&
    commands[0]!.includes('codex-read-only-hook.mjs') &&
    commands[0]!.endsWith(' --xezar-read-only-hook');
}

/** Codex executes hook commands through a shell, so every generated path must be one shell word. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function hookEntryCommands(entry: unknown): string[] {
  if (!entry || typeof entry !== 'object') return [];
  const commands = (entry as { hooks?: unknown }).hooks;
  if (!Array.isArray(commands)) return [];
  return commands.flatMap((handler) => {
    if (!handler || typeof handler !== 'object') return [];
    const command = (handler as { command?: unknown }).command;
    return typeof command === 'string' ? [command] : [];
  });
}

function findCodexHook(response: Record<string, unknown>, command: string): CodexHookMetadata | undefined {
  const rows = Array.isArray(response.data) ? response.data : [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const hooks = Array.isArray((row as { hooks?: unknown }).hooks)
      ? (row as { hooks: unknown[] }).hooks
      : [];
    for (const hook of hooks) {
      if (!hook || typeof hook !== 'object') continue;
      const metadata = hook as CodexHookMetadata;
      if (metadata.command === command && metadata.matcher === 'Bash' && metadata.enabled !== false) {
        return metadata;
      }
    }
  }
  return undefined;
}

function codexAskQuestions(value: unknown): AskQuestion[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return null;
  const questions: unknown[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const question = raw as Record<string, unknown>;
    if (question.isSecret === true) return null;
    const id = stringField(question, 'id');
    const header = stringField(question, 'header');
    const prompt = stringField(question, 'question');
    if (!id || !header || !prompt || !Array.isArray(question.options)) return null;
    const options = question.options.map((option) => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) return null;
      const record = option as Record<string, unknown>;
      const label = stringField(record, 'label');
      const description = stringField(record, 'description');
      return label ? { label, ...(description ? { description } : {}) } : null;
    }).filter((option): option is { label: string; description?: string } => option !== null);
    questions.push({ id, header, question: prompt, options, multiSelect: false });
  }
  return parseAskRequest({ questions })?.questions ?? null;
}

function userInputAnswers(questions: AskQuestion[], text: string): Record<string, { answers: string[] }> {
  const lines = text.split(/\r?\n/);
  const hasStructuredAnswer = questions.some((question) => lines.some((line) => line.startsWith(`${question.header}:`)));
  const answers: Record<string, { answers: string[] }> = {};
  for (const [index, question] of questions.entries()) {
    const prefix = `${question.header}:`;
    const matching = lines.find((line) => line.startsWith(prefix));
    const raw = matching?.slice(prefix.length).trim() ?? (!hasStructuredAnswer && index === 0 ? text.trim() : '');
    answers[question.id ?? String(index)] = {
      answers: raw === '' ? [] : raw.split(',').map((answer) => answer.trim()).filter(Boolean),
    };
  }
  return answers;
}

/** ThreadItem `type`s that are conversation text, not tool activity. */
const NON_TOOL_ITEMS = new Set(['agentMessage', 'userMessage', 'reasoning', 'plan']);

/** Turn-lifecycle notification methods — the only frames whose child-thread copies must be
 *  dropped so a sub-agent turn can't be mistaken for the parent's (#600). */
const TURN_LIFECYCLE_METHODS = new Set(['turn/started', 'turn/completed', 'turn/failed']);

const REASONING_SUMMARIES = new Set(['auto', 'concise', 'detailed', 'none']);

/**
 * The reasoning-summary override sent on `turn/start` (TurnStartParams.summary).
 * Defaults to `auto` so reasoning is visible out of the box — without it the
 * app-server runs with its own default (no summary) and the reasoning thread
 * stays empty even when the model reasons. `XEZ_CODEX_REASONING` overrides the
 * default (`auto`/`concise`/`detailed`, or `none` to opt out); an unrecognized
 * value falls back to `auto`.
 */
export function reasoningSummary(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.XEZ_CODEX_REASONING?.trim().toLowerCase();
  if (!raw) return 'auto';
  return REASONING_SUMMARIES.has(raw) ? raw : 'auto';
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** Drop undefined values so we never send `"model": null` to the server. */
function clean<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k as keyof T] = v as T[keyof T];
  }
  return out;
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function threadIdOf(res: Record<string, unknown>): string | undefined {
  const thread = res.thread as { id?: unknown } | undefined;
  return typeof thread?.id === 'string' ? thread.id : stringField(res, 'threadId');
}

function turnIdOf(obj: Record<string, unknown>): string | undefined {
  const turn = obj.turn as { id?: unknown } | undefined;
  return typeof turn?.id === 'string' ? turn.id : stringField(obj, 'turnId');
}

/** Cumulative tokens from a `thread/tokenUsage/updated` notification:
 *  `params.tokenUsage.total.totalTokens`. */
function tokenTotal(params: Record<string, unknown>): number {
  const usage = params.tokenUsage as { total?: { totalTokens?: unknown } } | undefined;
  const total = usage?.total?.totalTokens;
  return typeof total === 'number' ? total : 0;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
