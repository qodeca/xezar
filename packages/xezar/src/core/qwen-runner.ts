import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
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
  isXezarStopExit,
  prependSystemPrompt,
  trackChildExit,
} from './agent-runner.ts';
import { launch } from '../platform/process-launch.ts';
import { stopChildWithDescendants } from '../platform/process-tree.ts';
import { buildChildEnv } from './agent-env.ts';
import { readNdjson } from './ndjson.ts';
import { StderrTail } from './stderr-tail.ts';
import { costWeightedTokens } from './usage.ts';
import { stringifyToolResultContent, toolResultImageBlocks } from './claude-ui-mapper.ts';
import {
  AUTO_END_DELAY_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  EOF_KILL_GRACE_MS,
  EOF_TERM_GRACE_MS,
  KILL_GRACE_MS,
} from './claude-cli-runner.ts';
import { isReadOnlyStep } from './read-only-lock.ts';
import { qwenMcpIsolation, runMcpIsolationNote, writeMcpOverlay, type QwenMcpIsolation } from './run-mcp-isolation.ts';
import {
  QWEN_API_ERROR_PREFIX,
  createQwenUiState,
  isQwenRefusal,
  mapQwenMessage,
  qwenTokenUsage,
  qwenTurnStarted,
  unwrapQwenToolCall,
  type QwenUiMapping,
} from './qwen-ui-mapper.ts';
import {
  findQwenModel,
  qwenCostUsd,
  qwenHome,
  qwenModelEnvKeys,
  readQwenSettings,
  type QwenModelEntry,
  type QwenSettings,
} from './qwen-settings.ts';
import {
  QWEN_SYSTEM_SETTINGS_ENV,
  qwenDefaultSystemSettingsPath,
  qwenHookCommand,
  type QwenHookCommand,
  qwenSystemSettings,
  qwenUnblockableEnvMessage,
  qwenWorkspaceLooseningMessage,
  qwenWorkspaceLoosenings,
  scanQwenProjectEnv,
  writeQwenSystemSettings,
} from './qwen-run-config.ts';
import { QWEN_FILE_WRITERS, QWEN_TOOL_POLICY_ENV, qwenAllowedTools, qwenToolPolicy } from './qwen-tool-policy.ts';
import { installParenthetical, installThenLogin } from './provider-install.ts';

/**
 * The oldest Qwen Code xezar runs (#1041 locked decision 7). 0.25.2 is the version every measured
 * wire shape in this runner, its mapper and its fixtures comes from; it is also the first that
 * ships cross-session messaging on by default, which the leader client needs (#1043).
 */
export const QWEN_MIN_VERSION = '0.25.2';
/** The newest Qwen Code this runner was tested with. A newer one runs, with a quiet note. */
export const QWEN_TESTED_VERSION = '0.25.2';

/** `XEZ_QWEN_USAGE_STATISTICS=1` lets Qwen Code send its usage statistics; off by default (#1044 §11). */
export const QWEN_USAGE_STATISTICS_OPT_IN = 'XEZ_QWEN_USAGE_STATISTICS';

/** What a Qwen Code exit code means (Qwen Code's documented exit codes). */
const QWEN_EXIT_MEANINGS: Readonly<Record<number, string>> = {
  41: 'authentication failed',
  42: 'the input was rejected',
  44: 'the sandbox could not start',
  52: 'its configuration is invalid',
  53: 'it reached its session turn limit',
  54: 'a tool failed to execute',
  55: 'it ran out of its budget (turns, tool calls or wall time)',
};

/** Above this, a system prompt on the Windows command line risks its 32,767-character limit (#1008). */
const WINDOWS_ARGV_PROMPT_LIMIT = 8_000;

export interface QwenRunnerOptions {
  /** Override the binary; defaults to `XEZ_QWEN_BIN`, the dry-run mock, else `qwen` on PATH. */
  bin?: string;
  timeoutMs?: number;
  /** Test seam for reading the person's Qwen settings. */
  readSettings?: (home: string) => QwenSettings;
  /** Test seam for the bundled tool-policy hook program. */
  hookScriptPath?: string;
}

/**
 * Qwen Code switches every hook off when either of these is set (`getDisableAllHooks`: safe
 * mode, bare mode), whatever the system settings say. The tool-policy hook IS the step's
 * command lock, so a run always sets both to empty: a person's troubleshooting export must not
 * silently unlock a read-only step.
 */
export const QWEN_HOOK_DISABLING_ENV = ['QWEN_CODE_SAFE_MODE', 'QWEN_CODE_SIMPLE'] as const;

/** The qwen binary a spawn should use — shared with model discovery so both agree. */
export function resolveQwenExecutable(override?: string): string {
  if (override) return override;
  return process.env.XEZ_QWEN_BIN ?? (process.env.XEZ_DRY_RUN === '1' ? mockQwenPath() : 'qwen');
}

/**
 * `AgentRunner` over the Qwen Code CLI (#1044). One headless `qwen -o stream-json` process per
 * turn, joined by `--session-id` on the first turn and `--resume` after it (#1041 locked decision
 * 6: the stdin stream-json mode is "under construction" upstream). The session object outlives
 * its turn processes, so `sendMessage`, `end`, `interrupt` and the wall-clock deadline behave as
 * they do on the persistent-process runners: a message sent during a turn is queued for the next
 * one, exactly as Claude Code reads a mid-turn stdin message after its turn.
 *
 * Every run sets the approval mode explicitly (`default`: Qwen Code's own default is `auto`, a
 * model classifier) and carries a private system-settings file (`qwen-run-config.ts`) and, when
 * the step restricts tools, a PreToolUse hook (`qwen-tool-policy.ts`).
 */
export class QwenRunner implements AgentRunner {
  readonly backend = 'qwen' as const;

  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly readSettings: (home: string) => QwenSettings;
  private readonly hookScriptPath: string;
  private lastSession: AgentSession | null = null;

  constructor(opts: QwenRunnerOptions = {}) {
    this.bin = resolveQwenExecutable(opts.bin);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.readSettings = opts.readSettings ?? ((home) => readQwenSettings(home));
    this.hookScriptPath = opts.hookScriptPath ?? qwenHookScriptPath();
  }

  get defaultTimeoutMs(): number {
    return this.timeoutMs;
  }

  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }

  async interrupt(): Promise<void> {
    this.lastSession?.interrupt();
  }

  startSession(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void, opts: SessionOptions = {}): AgentSession {
    const env = { ...process.env, ...spec.env };
    const dryRun = process.env.XEZ_DRY_RUN === '1';
    const settings = dryRun ? emptySettings() : this.readSettings(qwenHome(env));
    const model = spec.model ? resolveModel(settings, spec.model) : undefined;

    const envScan = dryRun ? { excludedNames: [], unblockable: [] } : scanQwenProjectEnv(spec.cwd, env);
    if (envScan.unblockable.length > 0) throw new Error(qwenUnblockableEnvMessage(envScan.unblockable));
    if (!dryRun && isReadOnlyStep(spec.allowedTools)) {
      const loosening = qwenWorkspaceLoosenings(spec.cwd);
      if (loosening) throw new Error(qwenWorkspaceLooseningMessage(loosening));
    }

    const isolation = qwenMcpIsolation(spec.cwd);
    const isolationNote = runMcpIsolationNote('qwen', isolation);
    if (isolationNote) onEvent?.({ type: 'note', message: isolationNote });

    const policy = qwenToolPolicy(spec.allowedTools, spec.bashAllowlist);
    let hookCommand: QwenHookCommand | undefined;
    if (policy) {
      hookCommand = qwenHookCommand(process.execPath, this.hookScriptPath);
      if (hookCommand === undefined) {
        throw new Error('qwen: the tool-policy hook cannot be installed because a path holds a double quote, so this step could not keep its tool limits; it was not started');
      }
    }
    const system = qwenSystemSettings({
      basePath: process.env[QWEN_SYSTEM_SETTINGS_ENV]?.trim() || qwenDefaultSystemSettingsPath(),
      excludedEnvNames: envScan.excludedNames,
      ...(hookCommand !== undefined ? { hookCommand } : {}),
      usageStatistics: isTruthy(process.env[QWEN_USAGE_STATISTICS_OPT_IN]),
    });
    if (system.note) onEvent?.({ type: 'note', message: system.note });
    const settingsFile = writeQwenSystemSettings(system.settings);
    if (!settingsFile) {
      throw new Error('qwen: could not write the run\'s private Qwen Code settings file in the temp folder, so the run could not keep its tool limits and .env block; it was not started');
    }

    let mcpFile: ReturnType<typeof writeMcpOverlay> = null;
    if (isolation.mcpConfig) {
      mcpFile = writeMcpOverlay('mcp.json', isolation.mcpConfig);
      if (!mcpFile) {
        settingsFile.cleanup();
        throw new Error('qwen: could not write the run\'s MCP server list in the temp folder, so the run could not keep to the project\'s own servers; it was not started');
      }
    }

    const runEnv: Record<string, string> = {
      ...spec.env,
      [QWEN_SYSTEM_SETTINGS_ENV]: settingsFile.path,
      ...(policy ? { [QWEN_TOOL_POLICY_ENV]: JSON.stringify(policy) } : {}),
      ...Object.fromEntries(QWEN_HOOK_DISABLING_ENV.map((name) => [name, ''])),
    };
    if (!isTruthy(process.env[QWEN_USAGE_STATISTICS_OPT_IN])) runEnv.QWEN_USAGE_STATISTICS_ENABLED = '0';
    const childEnv = buildChildEnv({ backend: this.backend, extraEnv: runEnv, allowNames: qwenModelEnvKeys(settings) });

    const session = new QwenSession({
      bin: this.bin,
      spec,
      opts,
      onEvent,
      env: childEnv,
      model,
      isolation,
      limitMs: spec.timeoutMs ?? this.timeoutMs,
      settings,
      ...(mcpFile ? { mcpConfigPath: mcpFile.path } : {}),
      ...(hookCommand !== undefined ? { hookFiles: [process.execPath, this.hookScriptPath] } : {}),
      cleanup: () => {
        settingsFile.cleanup();
        mcpFile?.cleanup();
      },
    });
    this.lastSession = session.facade;
    return session.facade;
  }
}

/** The model a run asked for, checked against the person's Qwen settings before any spawn. */
function resolveModel(settings: QwenSettings, id: string): { id: string; entry?: QwenModelEntry } {
  const entry = findQwenModel(settings, id);
  if (entry) return { id, entry };
  // With providers listed, an id they do not name would make Qwen Code fall back to its default
  // model silently (measured on 0.25.2), so the run is refused instead. With none listed, the
  // person configures Qwen Code through its own env vars and xezar cannot check the id; the init
  // frame's model is still compared after the spawn.
  if (settings.models.length > 0) {
    const known = settings.models.map((model) => model.id).join(', ');
    throw new Error(`qwen: model "${id}" is not in your Qwen Code settings (modelProviders in ${settings.path}); known models: ${known}`);
  }
  return { id };
}

interface QwenSessionInit {
  bin: string;
  spec: AgentRunSpec;
  opts: SessionOptions;
  onEvent?: (event: AgentEvent) => void;
  env: NodeJS.ProcessEnv;
  model?: { id: string; entry?: QwenModelEntry };
  isolation: QwenMcpIsolation;
  /** The `--mcp-config` file with the project's own server definitions, when there are any. */
  mcpConfigPath?: string;
  /** The program and script the tool-policy hook runs, checked before every turn. */
  hookFiles?: readonly string[];
  limitMs: number;
  settings: QwenSettings;
  cleanup: () => void;
}

/** One turn's outcome, read from its frames and its exit. */
interface TurnOutcome {
  exitCode: number | null;
  stderr: string;
  sawResult: boolean;
  resultError?: string;
  apiError?: string;
  refusal?: string;
}

class QwenSession {
  readonly facade: AgentSession;

  private readonly init: QwenSessionInit;
  private sessionId: string | undefined;
  private turns = 0;
  private open = true;
  private queue: ContentBlock[][] = [];
  private wake: (() => void) | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private hasExited: (() => boolean) | null = null;
  private terminatedByXezar = false;
  /** The EOF watchdog had to stop a turn still running after `end()` (`AgentRunResult.stoppedAfterClose`). */
  private stoppedAfterClose = false;
  private timedOut = false;
  private stopRequested = false;
  private autoEndTimer: NodeJS.Timeout | undefined;
  private eofTermTimer: NodeJS.Timeout | undefined;
  private eofKillTimer: NodeJS.Timeout | undefined;
  private killTimer: NodeJS.Timeout | undefined;
  private readonly pidListeners: Array<(pid: number) => void> = [];
  private versionChecked = false;
  private uiState;
  // Never filled: no caller reads a result's tool calls, and keeping every call's full input
  // (a whole written file, a long command) grew with the session. Tool calls reach consumers as
  // `tool-call` events.
  private readonly toolCalls: AgentToolCallRecord[] = [];
  private readonly textChunks: string[] = [];
  private tokensUsed = 0;
  private sawUsage = false;
  private imageDir: string | null = null;
  /** The model the init frame named: the one priced when the run asked for none (`auto`). */
  private reportedModel: string | undefined;

  constructor(init: QwenSessionInit) {
    this.init = init;
    this.sessionId = init.spec.sessionId;
    this.uiState = createQwenUiState({
      fallbackSessionId: init.spec.sessionId,
      priceTurn: (usage) => qwenCostUsd(init.settings, this.pricedModel(), { input: usage.input + (usage.cacheRead ?? 0), output: usage.output }),
    });
    this.queue.push([...(init.spec.images ?? []), { type: 'text', text: init.spec.userPrompt }]);

    const self = this;
    const result = this.runAll();
    this.facade = {
      result,
      sendMessage: (content) => this.sendMessage(content),
      end: () => this.end(),
      interrupt: () => this.interrupt(),
      onProcessStart: (listener) => {
        this.pidListeners.push(listener);
        if (this.child?.pid !== undefined && !this.hasExited?.()) listener(this.child.pid);
      },
      get pid() {
        return self.child?.pid;
      },
      get open() {
        return self.open;
      },
    };
  }

  private emitUi(map: (state: typeof this.uiState) => QwenUiMapping): void {
    try {
      const mapped = map(this.uiState);
      this.uiState = mapped.state;
      if (this.init.opts.onUiEvent) for (const event of mapped.events) this.init.opts.onUiEvent(event);
    } catch {
      // v2 mapping is best-effort; v1 consumers stay unaffected.
    }
  }

  private sendMessage(content: ContentBlock[]): boolean {
    if (!this.open) return false;
    if (this.autoEndTimer) {
      clearTimeout(this.autoEndTimer);
      this.autoEndTimer = undefined;
    }
    this.queue.push(content);
    this.wake?.();
    return true;
  }

  private end(): void {
    if (!this.open) return;
    this.open = false;
    this.wake?.();
    // A turn still running gets the same EOF watchdog Claude Code's session gets.
    if (this.child && !this.hasExited?.()) {
      this.eofTermTimer = setTimeout(() => {
        if (!this.hasExited?.()) {
          this.stoppedAfterClose = true;
          this.signalChild('SIGTERM');
        }
        this.eofKillTimer = setTimeout(() => {
          if (!this.hasExited?.()) this.signalChild('SIGKILL');
        }, EOF_KILL_GRACE_MS);
        this.eofKillTimer.unref?.();
      }, EOF_TERM_GRACE_MS);
      this.eofTermTimer.unref?.();
    }
  }

  private interrupt(): void {
    this.open = false;
    this.stopRequested = true;
    this.queue = [];
    this.wake?.();
    if (this.child && !this.hasExited?.()) this.signalChild('SIGTERM');
  }

  private signalChild(signal: 'SIGTERM' | 'SIGKILL'): void {
    if (!this.child) return;
    this.terminatedByXezar = true;
    // `qwen` is a launcher that runs the real Qwen Code as its own child and waits: a signal to
    // the launcher alone left that turn running to its end, with the commands it started (#1042).
    void stopChildWithDescendants(this.child, signal);
  }

  /** The next turn's content, or null once the session is closed with nothing queued. */
  private async nextTurn(): Promise<ContentBlock[] | null> {
    for (;;) {
      if (this.stopRequested || this.timedOut) return null;
      if (this.queue.length > 0) {
        const messages = this.queue;
        this.queue = [];
        return messages.flat();
      }
      if (!this.open) return null;
      // REF'D on purpose (#1042, the #793 trap): Qwen Code runs one process per turn, so while an
      // open session waits for its next message nothing else may hold the event loop. A headless
      // `xezar run` whose session parked at `waiting` then exited 0 with the run left `running`;
      // the engine's idle timer is unref'd because a live agent process normally holds the loop.
      const hold = setInterval(() => undefined, 60_000);
      try {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      } finally {
        clearInterval(hold);
      }
      this.wake = null;
    }
  }

  private async runAll(): Promise<AgentRunResult> {
    const { onEvent, limitMs, spec } = this.init;
    let deadline: NodeJS.Timeout | undefined;
    if (limitMs > 0) {
      deadline = setTimeout(() => {
        this.timedOut = true;
        this.open = false;
        this.wake?.();
        if (this.child && !this.hasExited?.()) {
          this.signalChild('SIGTERM');
          this.child.stdout.destroy();
          this.killTimer = setTimeout(() => {
            if (!this.hasExited?.()) this.signalChild('SIGKILL');
          }, KILL_GRACE_MS);
          this.killTimer.unref?.();
        }
      }, limitMs);
      deadline.unref?.();
    }
    try {
      for (;;) {
        const content = await this.nextTurn();
        if (content === null) break;
        const outcome = await this.runTurn(content);
        const failure = this.turnFailure(outcome);
        if (failure) {
          onEvent?.({ type: 'error', message: failure });
          throw new Error(failure);
        }
        if (this.timedOut || this.stopRequested) break;
        onEvent?.({ type: 'turn-end' });
        if (this.init.opts.autoEndAfterFirstTurn && this.turns === 1 && this.open && this.queue.length === 0) {
          // REF'D on purpose: between turns no child process holds the event loop, so an unref'd
          // timer would let a headless `xezar run` exit before the session settles (#793).
          this.autoEndTimer = setTimeout(() => this.end(), AUTO_END_DELAY_MS);
        }
      }
    } finally {
      if (deadline) clearTimeout(deadline);
      if (this.autoEndTimer) clearTimeout(this.autoEndTimer);
      if (this.killTimer) clearTimeout(this.killTimer);
      if (this.eofTermTimer) clearTimeout(this.eofTermTimer);
      if (this.eofKillTimer) clearTimeout(this.eofKillTimer);
      this.open = false;
      this.init.cleanup();
      if (this.imageDir) rmSync(this.imageDir, { recursive: true, force: true });
    }

    const text = this.textChunks.join('\n').trim();
    const sessionId = this.sessionId ?? spec.sessionId;
    if (this.timedOut) {
      const mins = Math.round((limitMs / 60_000) * 10) / 10;
      onEvent?.({ type: 'error', message: `Qwen Code timed out after ${mins}m and was killed` });
      onEvent?.({ type: 'done' });
      return { text, toolCalls: this.toolCalls, tokensUsed: this.tokensUsed, sessionId, timedOut: true };
    }
    if (!this.sawUsage && this.turns > 0) onEvent?.({ type: 'note', message: 'token usage not reported by Qwen Code' });
    onEvent?.({ type: 'done' });
    // #943: the run manager sweeps what the agent left running behind a turn the watchdog stopped.
    const closeStop = this.stoppedAfterClose ? { stoppedAfterClose: true as const } : {};
    return { text, toolCalls: this.toolCalls, tokensUsed: this.tokensUsed, sessionId, ...closeStop };
  }

  /** Start one turn's process, read it to the end, and wait for its exit. */
  private async runTurn(content: ContentBlock[]): Promise<TurnOutcome> {
    const { bin, spec, onEvent, env } = this.init;
    this.turns += 1;
    const first = this.turns === 1;
    const resume = !first || spec.resume === true;
    const prompt = this.promptText(content, first);
    const args = buildQwenArgs(spec, {
      resume,
      sessionId: this.sessionId,
      model: this.init.model,
      mcpServerNames: this.init.isolation.allowed,
      ...(this.init.mcpConfigPath ? { mcpConfigPath: this.init.mcpConfigPath } : {}),
      imageDir: this.imageDir ?? undefined,
      systemPromptOnArgv: !promptGoesToStdin(spec.systemPrompt),
    });

    // Qwen Code lets a tool call through when its hook cannot run (a hook transport failure is
    // not a refusal), so a missing node or hook script would silently unlock the step. Checked per
    // turn: a Node upgrade between turns removes the program the settings file names.
    const missingHookFile = this.init.hookFiles?.find((file) => !existsSync(file));
    if (missingHookFile !== undefined) {
      throw new Error(`qwen: the program that keeps this step's tool limits is missing (${missingHookFile}), so the turn was not started; restart xezar after a Node update`);
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = launch(bin, args, { cwd: spec.cwd, env });
    } catch (err) {
      throw wrapSpawnError(err, bin);
    }
    this.child = child;
    this.terminatedByXezar = false;
    this.hasExited = trackChildExit(child);
    let spawnFailed: Error | null = null;
    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnFailed = wrapSpawnError(err, bin);
    });
    if (child.pid !== undefined) for (const listener of this.pidListeners) listener(child.pid);
    const stderrTail = new StderrTail();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => stderrTail.push(chunk));
    // An agent that exits before it reads a prompt larger than the pipe buffer fails the write with
    // EPIPE as an `error` event on stdin; unhandled, that event would stop the whole server. The
    // exit code and stderr already report the failure, so this only records it.
    child.stdin.on('error', (err) => {
      onEvent?.({ type: 'note', message: `qwen: stdin write failed: ${err.message}` });
    });
    try {
      child.stdin.end(prompt);
    } catch {
      // A child that never started reports through `error`.
    }
    this.emitUi(qwenTurnStarted);

    const outcome: TurnOutcome = { exitCode: null, stderr: '', sawResult: false };
    try {
      for await (const line of readNdjson(child.stdout)) {
        if (this.timedOut) break;
        let msg: QwenStreamMessage;
        try {
          msg = JSON.parse(line) as QwenStreamMessage;
        } catch {
          onEvent?.({ type: 'note', message: `qwen: skipped unparseable stream line: ${truncate(line)}` });
          continue;
        }
        const mapped = normalizeIntentionalTeardownResult(msg, this.terminatedByXezar);
        if (mapped.type === 'system' && mapped.subtype === 'init') this.onInit(mapped, child);
        else if (!this.versionChecked && (mapped.type === 'assistant' || mapped.type === 'user' || mapped.type === 'result')) {
          // The model is working and no init frame named a version: the gate must not be skipped.
          this.versionChecked = true;
          const verdict = qwenVersionVerdict(undefined);
          this.failTurn(child, verdict.kind === 'supported' ? 'qwen: Qwen Code reported no version' : verdict.message);
        }
        this.emitUi((state) => mapQwenMessage(mapped, state));
        try {
          this.handleFrame(mapped, outcome);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          onEvent?.({ type: 'note', message: `qwen: skipped malformed event (${msg.type ?? 'unknown'}): ${message}` });
        }
      }
    } catch (err) {
      if (!this.timedOut) throw err;
    }
    outcome.exitCode = await waitForExit(child);
    outcome.stderr = stderrTail.text().trim();
    if (spawnFailed) throw spawnFailed;
    return outcome;
  }

  /** The init frame: the real session id, the version gate, and the model check. */
  private onInit(msg: QwenStreamMessage, child: ChildProcessWithoutNullStreams): void {
    const { onEvent } = this.init;
    const id = typeof msg.session_id === 'string' && msg.session_id !== '' ? msg.session_id : undefined;
    if (id && id !== this.sessionId) {
      this.sessionId = id;
      onEvent?.({ type: 'session', sessionId: id });
    }
    if (!this.versionChecked) {
      this.versionChecked = true;
      const version = typeof msg.qwen_code_version === 'string' ? msg.qwen_code_version : undefined;
      const verdict = qwenVersionVerdict(version);
      if (verdict.kind === 'too-old') this.failTurn(child, verdict.message);
      else if (verdict.kind === 'untested') onEvent?.({ type: 'note', message: verdict.message });
    }
    if (typeof msg.model === 'string' && msg.model !== '') this.reportedModel = msg.model;
    const requested = this.init.model?.id;
    if (requested !== undefined && typeof msg.model === 'string' && msg.model !== requested) {
      this.failTurn(child, `qwen: Qwen Code started model "${msg.model}" instead of the requested "${requested}"; check the id in your Qwen Code settings (modelProviders)`);
    }
  }

  private pendingFailure: string | undefined;

  /** Stop a turn the runner refuses, and remember why. */
  private failTurn(child: ChildProcessWithoutNullStreams, message: string): void {
    this.pendingFailure ??= message;
    this.terminatedByXezar = true;
    void stopChildWithDescendants(child, 'SIGTERM');
  }

  private handleFrame(msg: QwenStreamMessage, outcome: TurnOutcome): void {
    const { onEvent } = this.init;
    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        const b = block as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
        if (b.type === 'text' && typeof b.text === 'string') {
          this.textChunks.push(b.text);
          onEvent?.({ type: 'text', text: b.text });
          if (msg.parent_tool_use_id == null && b.text.trimStart().startsWith(QWEN_API_ERROR_PREFIX)) outcome.apiError ??= b.text.trim();
        } else if (b.type === 'tool_use' && b.id && b.name) {
          const tool = unwrapQwenToolCall(b.name, b.input);
          onEvent?.({ type: 'tool-call', id: b.id, tool: tool.name, input: tool.input });
        }
      }
      return;
    }
    if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
        if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
        const result = stringifyToolResultContent(b.content);
        onEvent?.({ type: 'tool-result', toolCallId: b.tool_use_id, result, isError: b.is_error === true });
        // A refusal from xezar's own hook is recorded as a note, so the run record says what was
        // refused without the full log (#941).
        if (b.is_error === true && isQwenRefusal(result)) onEvent?.({ type: 'note', message: `qwen: tool call refused — ${truncate(result, 400)}` });
        for (const img of toolResultImageBlocks(b.content)) {
          onEvent?.({ type: 'image', mediaType: img.media_type, data: img.data });
        }
      }
      return;
    }
    if (msg.type === 'result') {
      outcome.sawResult = true;
      if (typeof msg.result === 'string' && this.textChunks.length === 0) {
        this.textChunks.push(msg.result);
        onEvent?.({ type: 'text', text: msg.result });
      }
      if (msg.is_error) {
        outcome.resultError = typeof msg.error?.message === 'string' && msg.error.message.trim() !== ''
          ? msg.error.message.trim()
          : typeof msg.result === 'string' && msg.result.trim() !== ''
            ? msg.result.trim()
            : `Qwen Code reported a result error${msg.subtype ? ` (${msg.subtype})` : ''}`;
      }
      const usage = qwenTokenUsage(msg.usage);
      if (usage) {
        const delta = costWeightedTokens({ input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: usage.cacheRead });
        if (delta > 0) {
          this.sawUsage = true;
          this.tokensUsed += delta;
          onEvent?.({ type: 'token-usage', tokensUsed: this.tokensUsed });
        }
        const usd = qwenCostUsd(this.init.settings, this.pricedModel(), { input: usage.input + (usage.cacheRead ?? 0), output: usage.output });
        if (usd !== undefined && usd > 0) onEvent?.({ type: 'cost', usd });
      }
    }
  }

  /** The model a turn's cost is looked up for: the requested one, else the one Qwen Code started. */
  private pricedModel(): string | undefined {
    return this.init.model?.id ?? this.reportedModel;
  }

  /** The step's failure for this turn, or undefined when it ended well. */
  private turnFailure(outcome: TurnOutcome): string | undefined {
    if (this.pendingFailure) return this.pendingFailure;
    if (this.timedOut) return undefined;
    const { exitCode, stderr } = outcome;
    // `null` is a death by signal: the `qwen` launcher re-raises the signal its program died of,
    // so a stop xezar sent arrives with no exit code at all.
    if (this.terminatedByXezar && (exitCode === null || isXezarStopExit(exitCode))) {
      if (!this.stopRequested) {
        this.init.onEvent?.({ type: 'note', message: `Qwen Code did not exit on its own after close; terminated by xezar (${exitCode === null ? 'by signal' : `code ${exitCode}`})` });
      }
      return undefined;
    }
    const detail = stderr ? ` — ${stderr.split('\n').slice(-3).join(' | ')}` : '';
    if (outcome.resultError) return `Qwen Code: ${outcome.resultError}${exitCode ? ` (exit ${exitCode})` : ''}`;
    if (exitCode !== 0 && exitCode !== null) {
      if (isSignalTerminationExit(exitCode)) return `${foreignSignalExitMessage('Qwen Code', exitCode)}${detail}`;
      const meaning = QWEN_EXIT_MEANINGS[exitCode];
      return `Qwen Code exited with code ${exitCode}${meaning ? ` (${meaning})` : ''}${detail}`;
    }
    // Qwen Code has reported a provider failure as a "success" before (upstream #8920, #11217):
    // the error text inside the turn is the authority.
    if (outcome.apiError) return `Qwen Code: ${outcome.apiError}`;
    if (!outcome.sawResult) return `Qwen Code ended the turn without a result${detail}`;
    return undefined;
  }

  /**
   * What goes to the turn's stdin. Images become files in a private folder, referenced as
   * `@<path>` — Qwen Code's own attachment syntax — because its headless stdin takes text only.
   * On the first turn, a system prompt too long for the Windows command line is prepended here.
   */
  private promptText(content: ContentBlock[], first: boolean): string {
    const texts: string[] = [];
    const refs: string[] = [];
    for (const block of content) {
      if (block.type === 'text') texts.push(block.text);
      else refs.push(`@${escapeAtPath(this.writeImage(block))}`);
    }
    let text = texts.join('\n');
    if (refs.length > 0) text = `${text}\n\n${refs.join(' ')}`;
    const { systemPrompt } = this.init.spec;
    if (first && promptGoesToStdin(systemPrompt)) text = prependSystemPrompt(systemPrompt, text);
    return text;
  }

  private imageCount = 0;

  private writeImage(block: Extract<ContentBlock, { type: 'image' }>): string {
    this.imageDir ??= mkdtempSync(join(tmpdir(), 'xez-qwen-img-'));
    const ext = block.source.media_type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
    const path = join(this.imageDir, `image-${++this.imageCount}.${ext}`);
    writeFileSync(path, Buffer.from(block.source.data, 'base64'), { mode: 0o600 });
    return path;
  }
}

/** Qwen Code's own question tool, which a headless run cannot answer. */
export const QWEN_ASK_TOOL = 'ask_user_question';

/** True when the system prompt must ride in the first message rather than on argv (#1008). */
function promptGoesToStdin(systemPrompt: string | undefined, platform: NodeJS.Platform = process.platform): boolean {
  return systemPrompt !== undefined && platform === 'win32' && systemPrompt.length > WINDOWS_ARGV_PROMPT_LIMIT;
}

/** `@path` takes a backslash before a space (Qwen Code's at-command parser). */
function escapeAtPath(path: string): string {
  return path.replace(/ /g, '\\ ');
}

export interface QwenTurnArgs {
  resume: boolean;
  sessionId?: string;
  model?: { id: string; entry?: QwenModelEntry };
  mcpServerNames: readonly string[];
  mcpConfigPath?: string;
  imageDir?: string;
  systemPromptOnArgv: boolean;
}

/**
 * One turn's argv. Every value rides in its flag's `--name=value` form, so a value that starts
 * with `-` is never read as a flag, and an array flag never swallows the next argument.
 */
export function buildQwenArgs(spec: AgentRunSpec, turn: QwenTurnArgs): string[] {
  const args: string[] = ['--output-format=stream-json', '--approval-mode=default', '--chat-recording'];
  if (turn.resume && turn.sessionId) args.push(`--resume=${turn.sessionId}`);
  else if (turn.sessionId) args.push(`--session-id=${turn.sessionId}`);
  if (turn.model) {
    args.push(`--model=${turn.model.id}`);
    if (turn.model.entry) args.push(`--auth-type=${turn.model.entry.authType}`);
  }
  if (spec.systemPrompt && turn.systemPromptOnArgv) args.push(`--append-system-prompt=${spec.systemPrompt}`);
  for (const tool of qwenAllowedTools(spec.allowedTools ?? [], spec.bashAllowlist)) args.push(`--allowed-tools=${tool}`);
  if (isReadOnlyStep(spec.allowedTools)) {
    for (const tool of [...QWEN_FILE_WRITERS, 'exec']) args.push(`--exclude-tools=${tool}`);
  }
  // A headless Qwen Code cannot collect an answer to its own question tool (0.25.2 returns an
  // error to the model), so the tool is removed and a question reaches the person the way it does
  // on every backend: the turn ends on an `XEZ:ASK` marker, raised as a question card.
  args.push(`--exclude-tools=${QWEN_ASK_TOOL}`);
  if (turn.mcpConfigPath) args.push(`--mcp-config=${turn.mcpConfigPath}`);
  for (const name of turn.mcpServerNames) args.push(`--allowed-mcp-server-names=${name}`);
  for (const dir of [...(spec.additionalDirectories ?? []), ...(turn.imageDir ? [turn.imageDir] : [])]) {
    args.push(`--include-directories=${dir}`);
  }
  return args;
}

export type QwenVersionVerdict =
  | { kind: 'supported' }
  | { kind: 'untested'; message: string }
  | { kind: 'too-old'; message: string };

/** The version gate: refuse below the minimum, note above the tested version (#1041 decision 7). */
export function qwenVersionVerdict(version: string | undefined): QwenVersionVerdict {
  // A missing version is refused, not waved through: it is how a release older than the floor
  // looks (#1067 review), and the floor is what keeps the tool limits and the .env block true.
  if (version === undefined || parseVersion(version) === undefined) {
    return {
      kind: 'too-old',
      message: `qwen: Qwen Code did not report a version xezar can read, so xezar cannot check that it is at least ${QWEN_MIN_VERSION}. Update it${installParenthetical('qwen')}, then start the task again.`,
    };
  }
  if (compareVersions(version, QWEN_MIN_VERSION) < 0) {
    return {
      kind: 'too-old',
      message: `qwen: Qwen Code ${version} is older than ${QWEN_MIN_VERSION}, the oldest version xezar supports. Update it${installParenthetical('qwen')}, then start the task again.`,
    };
  }
  if (compareVersions(version, QWEN_TESTED_VERSION) > 0) {
    return { kind: 'untested', message: `qwen: Qwen Code ${version} is not yet tested with xezar (tested up to ${QWEN_TESTED_VERSION}); it runs as usual` };
  }
  return { kind: 'supported' };
}

function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compareVersions(a: string, b: string): number {
  const left = parseVersion(a) ?? [0, 0, 0];
  const right = parseVersion(b) ?? [0, 0, 0];
  for (let index = 0; index < 3; index++) {
    const delta = left[index]! - right[index]!;
    if (delta !== 0) return delta;
  }
  return 0;
}

interface QwenStreamMessage {
  type?: string;
  subtype?: string;
  session_id?: unknown;
  model?: unknown;
  qwen_code_version?: unknown;
  parent_tool_use_id?: string | null;
  message?: { role?: string; content?: unknown[] };
  result?: string;
  usage?: unknown;
  is_error?: boolean;
  error?: { message?: unknown };
}

/** As on Claude Code: an error result while reacting to xezar's own stop describes the stop. */
function normalizeIntentionalTeardownResult(msg: QwenStreamMessage, terminatedByXezar: boolean): QwenStreamMessage {
  if (terminatedByXezar && msg.type === 'result' && msg.is_error === true && msg.subtype === 'error_during_execution') {
    return { ...msg, subtype: 'success', is_error: false };
  }
  return msg;
}

function emptySettings(): QwenSettings {
  return { status: 'absent', path: '', models: [], pricing: new Map() };
}

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}

function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** The bundled tool-policy hook (`scripts/qwen-pre-tool-hook.mjs`). */
export function qwenHookScriptPath(): string {
  return fileURLToPath(new URL('../../scripts/qwen-pre-tool-hook.mjs', import.meta.url));
}

/** Path to the bundled mock (`scripts/mock-qwen.mjs`), for XEZ_DRY_RUN=1. */
function mockQwenPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePath(here, '..', '..', 'scripts', 'mock-qwen.mjs');
}

/** @internal Exported for tests. */
export function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  // A child a signal ended has no exit code but a `signalCode`; when it died before this wait
  // listened, its `exit` and `close` have already fired, and only the safety timer would end the
  // wait (#1070, the same line in the Claude and Codex runners).
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    let done = false;
    const fin = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(safety);
      resolve(code);
    };
    child.once('close', (code) => fin(code));
    child.once('exit', (code) => fin(code));
    child.once('error', () => fin(child.exitCode ?? null));
    const safety = setTimeout(() => fin(child.exitCode ?? null), EOF_TERM_GRACE_MS + EOF_KILL_GRACE_MS + KILL_GRACE_MS + 5_000);
    safety.unref?.();
  });
}

/** A missing binary names the install command; nothing falls back to another backend (#1044 §14). */
export function wrapSpawnError(err: unknown, bin: string): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new Error(`\`${bin}\` not found on PATH — ${installThenLogin('qwen', 'Qwen Code', 'qwen')}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
