import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import type {
  AgentEvent,
  AgentRunResult,
  AgentRunSpec,
  AgentRunner,
  AgentSession,
  AgentToolCallRecord,
  ContentBlock,
  SessionOptions,
} from './agent-runner.js';
import { trackChildExit } from './agent-runner.js';
import { buildChildEnv } from './agent-env.js';
import { readNdjson } from './ndjson.js';
import { createPiUiState, mapPiRpcMessage, piTurnStarted } from './pi-ui-mapper.js';
import { V1TextCoalescer } from './v1-text-coalescer.js';
import type { StopReason } from './ui-events.js';

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
/** Grace period between SIGTERM and SIGKILL, matching `claude-cli-runner`. Exported so the
 *  escalation test can advance fake timers by the real value instead of a copy. */
export const KILL_GRACE_MS = 10_000;
const AUTO_END_DELAY_MS = 250;

export interface PiRunnerOptions {
  /** Override the binary name/path; defaults to `pi` on PATH (`XEZ_PI_BIN`). */
  bin?: string;
  /** Wall-clock timeout for a run (ms); per-spec `timeoutMs` still wins. */
  timeoutMs?: number;
}

/**
 * Persistent subprocess adapter for pi's documented RPC mode.
 *
 * Contract: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md
 * Pi has its own command/event vocabulary; it is not Claude stream-json.
 */
export class PiRunner implements AgentRunner {
  readonly backend = 'pi' as const;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private lastSession: AgentSession | null = null;

  constructor(opts: PiRunnerOptions = {}) {
    this.bin = opts.bin ?? process.env.XEZ_PI_BIN ?? (process.env.XEZ_DRY_RUN === '1' ? mockPiPath() : 'pi');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    const child = nodeSpawn(this.bin, buildPiArgs(spec), {
      cwd: spec.cwd,
      env: buildChildEnv({ backend: this.backend, extraEnv: spec.env }),
    });
    let open = true;
    let settled = true;
    let timedOut = false;
    let autoEndTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutKillTimer: NodeJS.Timeout | undefined;
    // "Is the child still alive?" is NOT `child.killed`, which only reports signal DELIVERY —
    // a CLI with its own SIGTERM handler flips that flag while the process runs on, and the
    // escalation written for exactly that case never fires (#844). AGENT_PROTOCOL requires
    // `trackChildExit`, which seeds from `exitCode`/`signalCode` and listens for `exit`.
    const hasExited = trackChildExit(child);
    let piUi = createPiUiState();
    const textChunks: string[] = [];
    const toolCalls: AgentToolCallRecord[] = [];
    // One v1 `text` per completed message, never per delta (claude parity): pi
    // streams text as deltas, and a marker split across deltas would otherwise
    // never parse (appendTurnText joins events with a newline, so a split
    // marker is no longer contiguous). Streaming display rides v2 `item.delta`.
    const textCoalescer = new V1TextCoalescer((text) => {
      textChunks.push(text);
      onEvent?.({ type: 'text', text });
    });
    // Where this turn started in the two output accumulators. "Did the turn
    // produce anything the user can see?" is then read off what was actually
    // emitted, instead of a flag every emitting branch has to remember to set
    // (#164). Taken at every `sendMessage`, because that is also where the v2
    // turn boundary is drawn (`piTurnStarted`), steering included.
    let turnTextMark = 0;
    let turnToolMark = 0;
    let sessionId = spec.sessionId;
    let tokensUsed = 0;
    let spawnError: Error | null = null;
    const stderr: string[] = [];

    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnError = wrapSpawnError(error, this.bin);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => stderr.push(chunk));

    const emitUi = (value: unknown): void => {
      const mapped = mapPiRpcMessage(value, piUi);
      piUi = mapped.state;
      for (const event of mapped.events) opts.onUiEvent?.(event);
    };
    const write = (command: Record<string, unknown>): boolean => {
      if (!open || !child.stdin.writable) return false;
      try {
        child.stdin.write(`${JSON.stringify(command)}\n`);
        return true;
      } catch {
        return false;
      }
    };
    const sendMessage = (content: ContentBlock[]): boolean => {
      const { message, images } = toPiPrompt(content);
      if (autoEndTimer) {
        clearTimeout(autoEndTimer);
        autoEndTimer = undefined;
      }
      if (
        !write({
          type: 'prompt',
          message,
          ...(images.length > 0 ? { images } : {}),
          ...(!settled ? { streamingBehavior: 'steer' } : {}),
        })
      ) {
        return false;
      }
      const mapped = piTurnStarted(piUi);
      piUi = mapped.state;
      for (const event of mapped.events) opts.onUiEvent?.(event);
      turnTextMark = textChunks.length;
      turnToolMark = toolCalls.length;
      settled = false;
      return true;
    };
    const end = (): void => {
      if (!open) return;
      open = false;
      child.stdin.end();
      killTimer = setTimeout(() => !hasExited() && child.kill('SIGTERM'), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    /**
     * Hard stop. Deliberately NOT guarded by `if (!open) return` any more: the wall-clock
     * deadline calls this, and a session that had already auto-ended (`autoEndAfterFirstTurn`
     * closes stdin and sets `open = false`) would otherwise make the timeout a no-op. Only the
     * RPC write needs the guard — signalling a live child never does.
     */
    const interrupt = (): void => {
      if (open) write({ type: 'abort' });
      open = false;
      if (!hasExited()) child.kill('SIGTERM');
    };

    write({ id: 'xezar-state', type: 'get_state' });
    sendMessage([
      ...(spec.images ?? []),
      {
        type: 'text',
        text: spec.userPrompt,
      },
    ]);

    const limitMs = spec.timeoutMs ?? this.timeoutMs;
    // Wall-clock kill switch, now with the escalation every other backend already has (D).
    // `interrupt()` alone was advisory: it sends the RPC abort and one SIGTERM, and a pi that
    // installs its own handler — or is wedged in a syscall — simply keeps running, so a step's
    // `timeout:` was enforced for claude/codex/opencode and merely a suggestion for pi.
    // AGENT_PROTOCOL requires parity at this seam, so this mirrors `claude-cli-runner`
    // line for line: interrupt, destroy stdout so the read loop cannot block forever, then
    // SIGKILL after `KILL_GRACE_MS` if the process is still alive.
    const deadline =
      limitMs > 0
        ? setTimeout(() => {
            timedOut = true;
            interrupt();
            child.stdout.destroy();
            timeoutKillTimer = setTimeout(() => {
              if (!hasExited()) child.kill('SIGKILL');
            }, KILL_GRACE_MS);
            timeoutKillTimer.unref?.();
          }, limitMs)
        : undefined;
    deadline?.unref?.();

    const result = (async (): Promise<AgentRunResult> => {
      try {
        for await (const line of readNdjson(child.stdout)) {
          // The deadline destroyed stdout; stop consuming whatever is still buffered.
          if (timedOut) break;
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            onEvent?.({ type: 'note', message: `pi: skipped unparseable RPC line: ${truncate(line)}` });
            continue;
          }
          emitUi(value);
          if (!isRecord(value)) continue;

          if (value.type === 'response' && value.command === 'get_state' && value.success === true && isRecord(value.data)) {
            const discovered = string(value.data.sessionId);
            if (discovered && discovered !== sessionId) {
              sessionId = discovered;
              onEvent?.({ type: 'session', sessionId: discovered });
            }
          } else if (value.type === 'response' && value.success === false) {
            onEvent?.({ type: 'error', message: rpcError(value) });
          } else if (value.type === 'message_update' && isRecord(value.assistantMessageEvent)) {
            const update = value.assistantMessageEvent;
            if (update.type === 'text_delta' && typeof update.delta === 'string') {
              textCoalescer.append(undefined, update.delta);
            }
          } else if (value.type === 'message_end' && isRecord(value.message) && value.message.role === 'assistant') {
            // pi's `message_end.message` is the authoritative AgentMessage, so
            // pass its text as the snapshot — the coalescer prefers it over the
            // accumulated deltas. pi's streaming events carry no stable item id
            // (contentIndex resets per message), so the anonymous '' bucket is
            // the documented path.
            textCoalescer.complete(undefined, contentText(value.message.content));
            const usage = usageValues(value.message.usage);
            if (usage) {
              tokensUsed += usage.weighted;
              onEvent?.({ type: 'token-usage', tokensUsed });
              if (usage.cost > 0) onEvent?.({ type: 'cost', usd: usage.cost });
            }
          } else if (value.type === 'tool_execution_start') {
            const id = string(value.toolCallId);
            const name = string(value.toolName);
            if (id && name) {
              toolCalls.push({ id, name, input: value.args });
              onEvent?.({ type: 'tool-call', id, tool: name, input: value.args });
            }
          } else if (value.type === 'tool_execution_end') {
            const id = string(value.toolCallId);
            if (id) {
              onEvent?.({
                type: 'tool-result',
                toolCallId: id,
                result: contentText(isRecord(value.result) ? value.result.content : undefined) ?? '',
                isError: value.isError === true,
              });
              emitImages(isRecord(value.result) ? value.result.content : undefined, onEvent);
            }
          } else if (value.type === 'agent_settled') {
            settled = true;
            // Surface prose from a message that never reached `message_end` (an
            // interrupted turn) before the turn boundary — the same flush codex
            // and opencode do on turn completion.
            textCoalescer.flush();
            // A turn that emitted no assistant text and no tool call used to
            // leave NOTHING in the transcript: the run just parked, and the one
            // fact that explained it (`output` sitting on the model's cap) lived
            // only in the raw NDJSON (#164). Say it in one line, before the turn
            // boundary, and name a cause only when pi's own `stopReason` carried
            // one.
            if (textChunks.length === turnTextMark && toolCalls.length === turnToolMark) {
              onEvent?.({ type: 'note', message: emptyTurnNote(piUi.stopReason) });
            }
            onEvent?.({ type: 'turn-end' });
            if (opts.autoEndAfterFirstTurn && open && !autoEndTimer) {
              autoEndTimer = setTimeout(end, AUTO_END_DELAY_MS);
              autoEndTimer.unref?.();
            }
          } else if (value.type === 'extension_error') {
            onEvent?.({ type: 'note', message: string(value.error) ?? 'pi extension error' });
          }
        }
      } catch (err) {
        // A timeout destroys stdout, which surfaces here as a premature-close error —
        // expected; rethrow anything else.
        if (!timedOut) throw err;
      } finally {
        if (deadline) clearTimeout(deadline);
        if (autoEndTimer) clearTimeout(autoEndTimer);
        if (killTimer) clearTimeout(killTimer);
        open = false;
      }

      // NOT cleared in the `finally` above, deliberately. Destroying stdout ends the read
      // loop within a microtask, so a `finally` that cleared this would disarm the SIGKILL
      // before its grace period had a chance to elapse — the escalation would exist in the
      // source and never fire. It is `unref`'d (it cannot hold the process open) and it
      // re-checks `hasExited()` before signalling, so leaving it armed until the child is
      // genuinely gone is both safe and the only way it does its job.
      const exitCode = await waitForExit(child);
      if (timeoutKillTimer) clearTimeout(timeoutKillTimer);
      if (spawnError) throw spawnError;

      // Timeout/interrupt can end the read loop mid-message — recover buffered
      // prose. `interrupt()` aborts and SIGTERMs at once, so stdout can end with
      // neither `message_end` nor `agent_settled` (the case noted below), and
      // the coalescer would otherwise drop text a pre-coalescing pi run kept.
      // Re-emission is impossible: `complete()` deletes the pending bucket, so a
      // settled turn leaves nothing for this flush to find.
      textCoalescer.flush();
      if (timedOut) {
        const message = `pi CLI timed out after ${Math.round((limitMs / 60_000) * 10) / 10}m and was killed`;
        onEvent?.({ type: 'error', message });
        onEvent?.({ type: 'done' });
        return { text: textChunks.join('\n').trim(), toolCalls, tokensUsed, sessionId };
      }
      if (exitCode !== 0 && exitCode !== null) {
        const detail = stderr.join('').trim().split('\n').slice(-3).join(' | ');
        const message = `pi CLI exited with code ${exitCode}${detail ? ` — ${detail}` : ''}`;
        onEvent?.({ type: 'error', message });
        throw new Error(message);
      }
      if (!settled) onEvent?.({ type: 'note', message: 'pi RPC session ended before agent_settled' });
      if (tokensUsed === 0) onEvent?.({ type: 'note', message: 'token usage not reported by pi CLI' });
      opts.onUiEvent?.({ type: 'session.ended', reason: piUi.stopReason });
      onEvent?.({ type: 'done' });
      return { text: textChunks.join('\n').trim(), toolCalls, tokensUsed, sessionId };
    })();

    const session: AgentSession = {
      result,
      sendMessage,
      end,
      interrupt,
      pid: child.pid,
      get open() {
        return open;
      },
    };
    this.lastSession = session;
    return session;
  }
}

export function buildPiArgs(spec: AgentRunSpec): string[] {
  const args = ['--mode', 'rpc'];
  if (spec.sessionId) args.push(spec.resume ? '--session' : '--session-id', spec.sessionId);
  if (spec.systemPrompt) args.push('--append-system-prompt', spec.systemPrompt);
  if (spec.model) args.push('--model', spec.model);
  const tools = piTools(spec.allowedTools ?? [], spec.bashAllowlist);
  if (tools.length > 0) args.push('--tools', tools.join(','));
  return args;
}

function piTools(tools: string[], bashAllowlist?: string[]): string[] {
  const map: Readonly<Record<string, string>> = {
    Read: 'read',
    Bash: 'bash',
    Edit: 'edit',
    Write: 'write',
    Grep: 'grep',
    Glob: 'find',
  };
  return [
    ...new Set(
      tools
        // Pi can allow/deny the whole bash tool but has no command-prefix
        // equivalent. Fail closed when a workflow requests that narrower mode.
        .filter((tool) => tool !== 'Bash' || !bashAllowlist || bashAllowlist.length === 0)
        .map((tool) => map[tool] ?? tool.toLowerCase()),
    ),
  ];
}

function toPiPrompt(content: ContentBlock[]): {
  message: string;
  images: Array<{ type: 'image'; data: string; mimeType: string }>;
} {
  const text: string[] = [];
  const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
  for (const block of content) {
    if (block.type === 'text') text.push(block.text);
    else images.push({ type: 'image', data: block.source.data, mimeType: block.source.media_type });
  }
  return { message: text.join('\n'), images };
}

/**
 * The one line a silent turn gets (#164). The cause is only ever the stop
 * reason pi itself reported (`message_end.message.stopReason`, normalized by
 * `pi-ui-mapper`); every other ending stays uncommitted about why, because the
 * wire does not say.
 */
function emptyTurnNote(stopReason: StopReason): string {
  if (stopReason === 'max_tokens') {
    return 'pi: the model produced no output this turn — it hit the output token limit';
  }
  return 'pi: the model produced no output this turn — no assistant text and no tool call';
}

function usageValues(value: unknown): { weighted: number; cost: number } | undefined {
  if (!isRecord(value)) return undefined;
  const input = number(value.input) ?? 0;
  const output = number(value.output) ?? 0;
  const cacheRead = number(value.cacheRead) ?? 0;
  const cacheWrite = number(value.cacheWrite) ?? 0;
  const cost = isRecord(value.cost) ? number(value.cost.total) ?? 0 : 0;
  return { weighted: Math.round(input + output + cacheRead * 0.1 + cacheWrite * 1.25), cost };
}

function emitImages(value: unknown, onEvent?: (event: AgentEvent) => void): void {
  if (!Array.isArray(value)) return;
  for (const part of value) {
    if (isRecord(part) && part.type === 'image') {
      const data = string(part.data);
      const mediaType = string(part.mimeType);
      if (data && mediaType) onEvent?.({ type: 'image', data, mediaType });
    }
  }
}

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((part) => (isRecord(part) && part.type === 'text' ? string(part.text) : undefined))
    .filter((part): part is string => part !== undefined);
  return text.length > 0 ? text.join('\n') : undefined;
}

function rpcError(value: Record<string, unknown>): string {
  const error = isRecord(value.error) ? value.error : undefined;
  return string(error?.message) ?? string(value.message) ?? `pi RPC command ${string(value.command) ?? 'unknown'} failed`;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('close', resolve));
}

function wrapSpawnError(error: NodeJS.ErrnoException, bin: string): Error {
  if (error.code === 'ENOENT') {
    return new Error(`\`${bin}\` not found on PATH — install pi and run \`pi\` once to configure a provider`);
  }
  return error;
}

/** Path to the bundled mock (`scripts/mock-pi-rpc.mjs`), for XEZ_DRY_RUN=1. */
function mockPiPath(): string {
  // Resolved the same way `mockClaudePath` is, rather than through `new URL().pathname`:
  // on Windows that yields a leading-slash `/C:/…` which `spawn` cannot execute.
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <pkg>/dist/core (built) or <pkg>/src/core (tsx dev).
  return resolvePath(here, '..', '..', 'scripts', 'mock-pi-rpc.mjs');
}

function truncate(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
