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
import { foreignSignalExitMessage, isSignalTerminationExit, trackChildExit } from './agent-runner.js';
import { buildChildEnv } from './agent-env.js';
import { piMcpIsolation, runMcpIsolationNote, writeMcpOverlay } from './run-mcp-isolation.js';
import { readNdjson } from './ndjson.js';
import { answerPiDialog, cancelPiDialog, denyPiDialog, readPiDialog, type PiDialog } from './pi-dialog.js';
import { createPiUiState, mapPiRpcMessage, piTurnStarted } from './pi-ui-mapper.js';
import { V1TextCoalescer } from './v1-text-coalescer.js';
import type { StopReason, UiEvent } from './ui-events.js';

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
/** Grace period between SIGTERM and SIGKILL, matching `claude-cli-runner`. Exported so the
 *  escalation test can advance fake timers by the real value instead of a copy. */
export const KILL_GRACE_MS = 10_000;
const AUTO_END_DELAY_MS = 250;
/** Hard bound on one `--help` capability probe: past it the answer is UNKNOWN and the child is
 *  SIGKILLed, because a pi that traps SIGTERM would otherwise hold the probe open (#548). */
export const MCP_CONFIG_PROBE_TIMEOUT_MS = 10_000;
/** Cap on the probe output kept in memory; `--help` is a page, anything larger is not an answer. */
const MCP_CONFIG_PROBE_OUTPUT_CAP = 256 * 1024;
/** The exact spawn failure a pi without the MCP adapter extension answers `--mcp-config` with. */
const UNKNOWN_MCP_CONFIG_OPTION = 'Unknown option: --mcp-config';

/* The three notes the capability answer can produce. Each says only what was established: the
 * first that the extension was asked for and is not there, the second that the question could
 * not be answered at all, the third that the running pi refused the option after all. */
const EXTENSION_ABSENT_NOTE =
  'pi: the optional MCP adapter extension is not available for this task\'s folder and agent '
  + 'account, so pi reads no MCP configuration at all and this run starts with no MCP servers — '
  + 'there is nothing to switch off, so no MCP isolation was applied.';
const PROBE_UNKNOWN_NOTE =
  'pi: could not confirm whether this pi accepts an MCP configuration file for this task\'s folder '
  + 'and agent account, so the flag was left out; this run starts with no MCP servers and no MCP '
  + 'isolation was applied.';
const RESTARTED_WITHOUT_MCP_CONFIG_NOTE =
  'pi: this pi rejected the MCP configuration option at start-up, so the session was started once '
  + 'more without it; this run starts with no MCP servers and no MCP isolation was applied.';
/** What a session cancelled or closed inside the capability-probe window says (#648 B). */
const CANCELLED_BEFORE_SPAWN_NOTE =
  'pi: the session was closed before its pi process started, so no pi was spawned and nothing was '
  + 'sent to one.';

export interface PiRunnerOptions {
  /** Override the binary name/path; defaults to `pi` on PATH (`XEZ_PI_BIN`). */
  bin?: string;
  /** Wall-clock timeout for a run (ms); per-spec `timeoutMs` still wins. */
  timeoutMs?: number;
  /** Seam for the `--mcp-config` capability probe (`piSupportsMcpConfig`); tests inject here. */
  supportsMcpConfig?: PiMcpConfigProbe;
}

/**
 * What the probe established — three answers, not two. `unknown` is what a probe that could not
 * run at all reports, and it is deliberately NOT the same fact as `no`: both leave the flag out,
 * but only `no` licenses a note saying the extension is absent, a cause a failed probe cannot
 * know. Keeping them apart is what stops the transcript asserting something nobody measured.
 */
export type PiMcpConfigAnswer = 'yes' | 'no' | 'unknown';

/** Answers "does THIS pi, in THIS folder and with THIS child env, know `--mcp-config`?" (#548).
 *
 *  The last two arguments are optional on purpose: an injected probe may ignore both, and the
 *  runner supplies only `signal` — the seam by which a cancelled session stops waiting for an
 *  answer it no longer wants AND gets the probe child killed rather than left running to its own
 *  bound (#648 C). `timeoutMs` keeps its existing fourth position so `piSupportsMcpConfig` still
 *  satisfies this type. */
export type PiMcpConfigProbe = (
  bin: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<PiMcpConfigAnswer>;

/**
 * Is `--mcp-config` a flag this pi accepts, for the folder and the account THIS task will use?
 *
 * It is NOT a pi flag: the optional `pi-mcp-adapter` extension registers it, and an extension
 * resolves from the agent directory AND from the project folder the child runs in — pi loads a
 * project's own `.pi/extensions/*` and the packages named in its `.pi/settings.json` once that
 * project is trusted. So one binary and one agent home answer differently per folder, and the
 * only honest question carries all three: binary, child env, child cwd. Passing the flag to a pi
 * that does not know it is fatal at spawn (`Error: Unknown option: --mcp-config`, exit 1), which
 * is what #548 reported.
 *
 * `pi --help` is the cheapest reliable question: it loads the same extensions, prints the option
 * only when one registers it, and exits 0 in about 0.2–0.4 s warm (2.5 s cold). It is asked once
 * per session start and the answer is NOT cached: an answer that depends on the folder saves
 * nothing across tasks, and a cached answer is exactly what goes stale when the extension is
 * installed or removed while the server runs.
 *
 * Never throws, never blocks the event loop and never guesses upward. A missing binary, a
 * non-zero exit or any other failure answers `unknown`; past the hard bound the child is
 * SIGKILLed — not SIGTERMed, which a pi with its own handler may simply ignore — and the answer
 * is `unknown` at once, without waiting for the corpse. Both leave the flag out, which is the
 * safe direction: a pi that reads no MCP config file loads no MCP servers at all.
 *
 * `signal` is the cancel seam (#648 C): an aborted probe answers `unknown` at once and SIGKILLs
 * its child on the way out, so cancelling a run inside the probe window is not delayed by up to
 * `MCP_CONFIG_PROBE_TIMEOUT_MS` and leaves no `pi --help` behind.
 */
export function piSupportsMcpConfig(
  bin: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number = MCP_CONFIG_PROBE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<PiMcpConfigAnswer> {
  return new Promise<PiMcpConfigAnswer>((resolve) => {
    let child: ReturnType<typeof nodeSpawn> | undefined;
    let done = false;
    const settle = (answer: PiMcpConfigAnswer): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(answer);
    };
    // Same treatment as the bound above: SIGKILL, and answer without waiting for the corpse.
    const onAbort = (): void => {
      child?.kill('SIGKILL');
      settle('unknown');
    };
    // The hard bound. It resolves WITHOUT waiting for the corpse, so a child that ignores
    // signals delays nothing, and it signals SIGKILL because SIGTERM is exactly what a CLI
    // with its own handler absorbs (measured: 30 s held on a SIGTERM-trapping child).
    const timer = setTimeout(() => {
      child?.kill('SIGKILL');
      settle('unknown');
    }, timeoutMs);
    timer.unref?.();
    // Cancelled before the question was even asked: no child, no wait.
    if (signal?.aborted) {
      settle('unknown');
      return;
    }
    signal?.addEventListener('abort', onAbort);

    try {
      child = nodeSpawn(bin, ['--help'], {
        cwd,
        env,
        // No stdin at all: a binary that reads it sees EOF and cannot hold the probe open.
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      settle('unknown');
      return;
    }

    let output = '';
    const collect = (chunk: Buffer | string): void => {
      if (output.length >= MCP_CONFIG_PROBE_OUTPUT_CAP) return;
      output += String(chunk);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', () => settle('unknown'));
    child.on('close', (code) => {
      if (code !== 0) return settle('unknown');
      settle(output.includes('--mcp-config') ? 'yes' : 'no');
    });
  });
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
  private readonly supportsMcpConfig: PiMcpConfigProbe;
  private lastSession: AgentSession | null = null;

  constructor(opts: PiRunnerOptions = {}) {
    this.bin = opts.bin ?? process.env.XEZ_PI_BIN ?? (process.env.XEZ_DRY_RUN === '1' ? mockPiPath() : 'pi');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.supportsMcpConfig = opts.supportsMcpConfig ?? piSupportsMcpConfig;
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

  /**
   * AGENT_PROTOCOL's seam is unchanged: this still RETURNS an `AgentSession` synchronously.
   *
   * What changed underneath is that the child can no longer be spawned synchronously. The
   * `--mcp-config` capability question has to be answered BEFORE the argv is final, it has to be
   * answered for the folder and account THIS task uses, and asking it must never block the
   * server's event loop (#548). So the answer is awaited, and what comes back from here is a
   * facade over the child that is about to exist: a `sendMessage` arriving inside that window is
   * replayed onto the real session the moment it opens, `pid` reports the child once there is one
   * (`onProcessStart` announces it, and announces it again if the fallback below has to restart),
   * and `result` settles with the real session's result.
   *
   * An `end()` or `interrupt()` arriving inside that window is NOT replayed onto a child: it
   * cancels the child instead (#648 B), because there is nothing yet to close gracefully and
   * spawning a pi only to tear it down writes the opening prompt to a session nobody is waiting
   * on. The probe is aborted with it, so the cancel is not delayed by the probe's own bound.
   */
  startSession(
    spec: AgentRunSpec,
    onEvent?: (event: AgentEvent) => void,
    opts: SessionOptions = {},
  ): AgentSession {
    let live: AgentSession | null = null;
    let ended = false;
    let interrupted = false;
    const queued: ContentBlock[][] = [];
    /** What the facade has already handed to a child. A restart below re-queues it, so a message
     *  typed while the first attempt was dying at spawn is not lost with that attempt — whether
     *  it was typed before the child existed or after it was adopted (#648 A).
     *
     *  Kept only while `replayable`, which is what stops this being the whole transcript: a
     *  session that cannot restart (no `--mcp-config` was passed) records nothing here at all,
     *  and one that can stops recording the moment the child proves it runs. */
    const delivered: ContentBlock[][] = [];
    /** Could a message already handed to the live child still need replaying onto a replacement? */
    let replayable = false;
    /** Cancels the capability probe. A session interrupted or closed inside the probe window must
     *  not wait out `MCP_CONFIG_PROBE_TIMEOUT_MS`, and must not leave the probe child behind. */
    const probeCancel = new AbortController();
    const pidListeners: Array<(pid: number) => void> = [];
    let settleResult!: (inner: Promise<AgentRunResult>) => void;
    const result = new Promise<AgentRunResult>((resolve, reject) => {
      settleResult = (inner) => void inner.then(resolve, reject);
    });
    /** Point the facade at a real session — at the first child, and again at a restart.
     *  `canReplay` says whether a restart is still on the table for THIS child; a replacement
     *  gets `false`, because the fallback is one-shot. */
    const adopt = (session: AgentSession, canReplay: boolean): void => {
      live = session;
      replayable = canReplay;
      if (session.pid !== undefined) for (const listener of pidListeners) listener(session.pid);
      for (const content of queued.splice(0)) {
        if (canReplay) delivered.push(content);
        session.sendMessage(content);
      }
      if (interrupted) session.interrupt();
      else if (ended) session.end();
    };

    const open = async (): Promise<AgentRunResult> => {
      // What this run may reach over MCP is decided once, before the child exists (#342): the
      // project's servers keep working, xezar's own leader bridge is switched off for this client.
      // `spec.env` carries `PI_CODING_AGENT_DIR` for a stored pi agent account (`profileEnv`), so
      // the env the child actually spawns with is what must resolve the agent home — not the host
      // default — and `spec.cwd` is the folder whose own `.pi` the child will read.
      const childEnv = buildChildEnv({ backend: this.backend, extraEnv: spec.env });
      let answer: PiMcpConfigAnswer = 'unknown';
      try {
        answer = await this.supportsMcpConfig(this.bin, childEnv, spec.cwd, undefined, probeCancel.signal);
      } catch {
        // A probe that rejects established nothing, which is not the same as "no extension".
        answer = 'unknown';
      }

      // Cancelled or closed while the question was being asked (#648 B). The probe still ran
      // FIRST — that ordering is what #548 needs and it is unchanged — this only decides whether
      // its answer is still wanted, and for a session nobody is waiting on any more it is not:
      // spawning here would start a pi, write the opening prompt to it and only then tear it
      // down. `open` already reported this session closed, so the child would also have flipped
      // it back to open.
      if (interrupted || ended) {
        onEvent?.({ type: 'note', message: CANCELLED_BEFORE_SPAWN_NOTE });
        opts.onUiEvent?.({ type: 'session.ended', reason: 'cancelled' });
        onEvent?.({ type: 'done' });
        return { text: '', toolCalls: [], tokensUsed: 0, sessionId: spec.sessionId };
      }

      let mcpOverlay: ReturnType<typeof writeMcpOverlay> = null;
      if (answer === 'yes') {
        const isolation = piMcpIsolation(spec.cwd, { ...process.env, ...spec.env });
        const isolationNote = runMcpIsolationNote('pi', isolation);
        if (isolationNote) onEvent?.({ type: 'note', message: isolationNote });
        mcpOverlay = writeMcpOverlay('mcp.json', isolation.overlay);
        if (!mcpOverlay) {
          onEvent?.({
            type: 'note',
            message: 'pi: could not write this run\'s private MCP overlay, so the run starts without it '
              + 'and may load xezar\'s leader bridge; check that $TMPDIR is writable (#342).',
          });
        }
      } else {
        // Two different facts, two different sentences. Saying "not installed" after a probe
        // that failed would state a cause nobody measured.
        onEvent?.({ type: 'note', message: answer === 'no' ? EXTENSION_ABSENT_NOTE : PROBE_UNKNOWN_NOTE });
      }

      // Belt to the probe's braces (the remove-late case): if this child dies at spawn on the
      // very option the probe said it knew, start the session once more without it. Exactly
      // one retry, only for that error, and only before any RPC output arrived.
      const restart = mcpOverlay
        ? (): AgentSession | null => {
            if (interrupted) return null;
            onEvent?.({ type: 'note', message: RESTARTED_WITHOUT_MCP_CONFIG_NOTE });
            // The opening prompt rides `spec.userPrompt` and is sent again on its own; anything
            // the facade had already handed to the dead attempt goes back on the queue.
            queued.unshift(...delivered.splice(0));
            const replacement = this.spawnSession(spec, onEvent, opts, childEnv, null, null);
            adopt(replacement, false);
            return replacement;
          }
        : null;

      // The restart window closes at the first RPC line: whatever this child was handed has
      // reached a pi that runs, so nothing needs holding for a replacement that can no longer
      // happen.
      const session = this.spawnSession(spec, onEvent, opts, childEnv, mcpOverlay, restart, () => {
        replayable = false;
        delivered.length = 0;
      });
      adopt(session, restart !== null);
      return await session.result;
    };
    settleResult(open());

    const session: AgentSession = {
      result,
      sendMessage: (content) => {
        if (live) {
          const accepted = live.sendMessage(content);
          // Recorded only while a restart could still need it (#648 A); a message the child
          // refused was never handed over, so there is nothing to replay.
          if (accepted && replayable) delivered.push(content);
          return accepted;
        }
        if (ended || interrupted) return false;
        queued.push(content);
        return true;
      },
      end: () => {
        ended = true;
        probeCancel.abort();
        live?.end();
      },
      interrupt: () => {
        interrupted = true;
        probeCancel.abort();
        live?.interrupt();
      },
      onProcessStart: (listener) => {
        pidListeners.push(listener);
        if (live?.pid !== undefined) listener(live.pid);
      },
      get pid() {
        return live?.pid;
      },
      get open() {
        return live ? live.open : !ended && !interrupted;
      },
    };
    this.lastSession = session;
    return session;
  }

  /**
   * The real session over one spawned pi child. `mcpOverlay` is the decided #342 answer (null =
   * no `--mcp-config`), and `restart` is the one-shot fallback `startSession` supplies only when
   * the flag really was passed. `onRestartWindowClosed` fires at the first RPC line — the moment
   * that fallback stops being possible — so the facade can drop what it was holding for it.
   */
  private spawnSession(
    spec: AgentRunSpec,
    onEvent: ((event: AgentEvent) => void) | undefined,
    opts: SessionOptions,
    childEnv: NodeJS.ProcessEnv,
    mcpOverlay: ReturnType<typeof writeMcpOverlay>,
    restart: (() => AgentSession | null) | null,
    onRestartWindowClosed?: () => void,
  ): AgentSession {
    const child = nodeSpawn(this.bin, buildPiArgs(spec, mcpOverlay?.path), {
      cwd: spec.cwd,
      env: childEnv,
    });
    // The overlay only has to outlive the child. Both events are wired because a spawn that
    // never starts emits `error`+`close` and no `exit`; `cleanup` is idempotent.
    if (mcpOverlay) {
      child.once('exit', mcpOverlay.cleanup);
      child.once('close', mcpOverlay.cleanup);
    }
    let open = true;
    let settled = true;
    let timedOut = false;
    let terminatedByXezar = false;
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
    // The extension dialog pi is blocked on, if any (#369). pi's dialog methods have no
    // timeout of their own: an `extension_ui_request` that nobody answers holds the turn
    // open for ever (pi-mcp-adapter's `approveTools` gate is one). While one is pending the
    // next `sendMessage` is its answer, on pi's own sub-protocol, not a new prompt.
    let pendingDialog: PiDialog | null = null;
    let sessionId = spec.sessionId;
    let tokensUsed = 0;
    let spawnError: Error | null = null;
    /** Did this child ever answer on the RPC channel? The restart below is only for a child
     *  that died before saying anything — never for a failure mid-run. */
    let sawRpcOutput = false;
    const stderr: string[] = [];

    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnError = wrapSpawnError(error, this.bin);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => stderr.push(chunk));

    /**
     * v2 events, held while a restart is still on the table.
     *
     * The opening `turn.started` is emitted before the child has proved it can run at all, so on
     * the one path that restarts — a spawn the flag killed — the cockpit would otherwise see two
     * `turn.started` for one turn. Holding costs nothing: the writes still go out (pi is waiting
     * for them), and the hold is released by the first RPC line or by the child's exit.
     */
    let heldUi: UiEvent[] | null = restart ? [] : null;
    const emitUiEvent = (event: UiEvent): void => {
      if (heldUi) heldUi.push(event);
      else opts.onUiEvent?.(event);
    };
    const releaseUi = (): void => {
      if (!heldUi) return;
      const held = heldUi;
      heldUi = null;
      for (const event of held) opts.onUiEvent?.(event);
    };
    const emitUi = (value: unknown): void => {
      const mapped = mapPiRpcMessage(value, piUi);
      piUi = mapped.state;
      for (const event of mapped.events) emitUiEvent(event);
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
    /** Resolve the pending dialog with one response frame; `false` when there is none. */
    const settleDialog = (respond: (dialog: PiDialog) => { response: Record<string, unknown>; note: string }): boolean => {
      const dialog = pendingDialog;
      if (!dialog) return false;
      pendingDialog = null;
      const { response, note } = respond(dialog);
      write(response);
      onEvent?.({ type: 'note', message: note });
      return true;
    };
    const handleDialogFrame = (value: unknown): void => {
      const frame = readPiDialog(value);
      if (frame.kind === 'ignore') return;
      if (frame.kind === 'notice') {
        // Fire-and-forget: pi expects no response. One transcript line, because this is
        // where pi-mcp-adapter reports "MCP: xezar connected" — or that it was refused.
        onEvent?.({ type: 'note', message: `pi: ${frame.message}` });
        return;
      }
      if (frame.kind === 'unsupported') {
        // pi is blocked on it and the ask card cannot carry it (`input`/`editor`, or a
        // `select` outside the card's 2–4 option window): dismiss it now, never leave it.
        write(cancelPiDialog(frame.id));
        onEvent?.({
          type: 'note',
          message: `pi: dismissed a "${frame.method}" extension dialog xezar cannot show ("${truncate(frame.title, 120)}")`,
        });
        return;
      }
      const { dialog } = frame;
      if (opts.autonomous) {
        // Autonomous: nobody is watching, so an explicit refusal at once — the safe default
        // (#369) — recorded in the transcript instead of a silent hang or a silent approval.
        const { response, answer } = denyPiDialog(dialog);
        write(response);
        onEvent?.({
          type: 'note',
          message: `pi: refused an extension dialog — autonomous run, nobody can approve it (answered "${answer}" to "${truncate(dialog.title, 120)}")`,
        });
        return;
      }
      // A second dialog before the first was answered: the older one can no longer be
      // answered through the card, so dismiss it rather than leave TWO blocking frames.
      settleDialog((previous) => ({
        response: cancelPiDialog(previous.id),
        note: `pi: dismissed an extension dialog superseded by a newer one ("${truncate(previous.title, 120)}")`,
      }));
      pendingDialog = dialog;
      emitUiEvent({ type: 'ask.requested', requestId: `pi-${dialog.id}`, questions: [dialog.question] });
    };
    const sendMessage = (content: ContentBlock[]): boolean => {
      const { message, images } = toPiPrompt(content);
      if (autoEndTimer) {
        clearTimeout(autoEndTimer);
        autoEndTimer = undefined;
      }
      if (!open) return false;
      // The reply to a pending dialog rides pi's extension-UI sub-protocol, correlated by
      // the id pi chose; the turn it belongs to is still in flight, so no new turn starts.
      if (
        settleDialog((dialog) => {
          const { response, matched } = answerPiDialog(dialog, message);
          return {
            response,
            note:
              matched === null
                ? `pi: the reply named none of the dialog's options (${dialog.options.join(' / ')}) — dialog dismissed`
                : `pi: answered "${matched}" to "${truncate(dialog.title, 120)}"`,
          };
        })
      ) {
        return true;
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
      for (const event of mapped.events) emitUiEvent(event);
      turnTextMark = textChunks.length;
      turnToolMark = toolCalls.length;
      settled = false;
      return true;
    };
    // The same bit the claude and codex runners keep (#703): set the moment WE
    // signal this child, so its 128+signal exit reads as our own teardown and a
    // signal exit WITHOUT it reads as one xezar never sent (#156).
    const signalChild = (signal: 'SIGTERM'): void => {
      terminatedByXezar = true;
      child.kill(signal);
    };
    const end = (): void => {
      if (!open) return;
      // A dialog still open at close is dismissed first, so pi's turn ends on its own
      // protocol instead of on the EOF the grace period would otherwise have to enforce.
      settleDialog((dialog) => ({
        response: cancelPiDialog(dialog.id),
        note: `pi: dismissed an unanswered extension dialog at session close ("${truncate(dialog.title, 120)}")`,
      }));
      open = false;
      child.stdin.end();
      killTimer = setTimeout(() => !hasExited() && signalChild('SIGTERM'), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    /**
     * Hard stop. Deliberately NOT guarded by `if (!open) return` any more: the wall-clock
     * deadline calls this, and a session that had already auto-ended (`autoEndAfterFirstTurn`
     * closes stdin and sets `open = false`) would otherwise make the timeout a no-op. Only the
     * RPC write needs the guard — signalling a live child never does.
     */
    const interrupt = (): void => {
      if (open) {
        settleDialog((dialog) => ({
          response: cancelPiDialog(dialog.id),
          note: `pi: dismissed an unanswered extension dialog on interrupt ("${truncate(dialog.title, 120)}")`,
        }));
        write({ type: 'abort' });
      }
      open = false;
      if (!hasExited()) signalChild('SIGTERM');
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
          // One RPC line is proof this child started: the restart window is over, and
          // whatever v2 events were held for it are the real session's now.
          if (!sawRpcOutput) {
            sawRpcOutput = true;
            onRestartWindowClosed?.();
          }
          releaseUi();
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            onEvent?.({ type: 'note', message: `pi: skipped unparseable RPC line: ${truncate(line)}` });
            continue;
          }
          emitUi(value);
          handleDialogFrame(value);
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
            // A dialog cannot outlive its turn; whatever pi resolved it as, the card is stale.
            pendingDialog = null;
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

      // The self-healing fallback (#548). The probe said this pi knew the option and the pi that
      // actually ran refused it — someone removed or disabled the extension between the two, or
      // the probe was wrong. Exactly ONE more attempt, without the flag: only when the flag was
      // really passed (`restart` is null otherwise), only for THIS error, and only for a child
      // that died before a single RPC line, so a mid-run failure can never loop.
      if (
        restart
        && !sawRpcOutput
        && exitCode !== 0
        && exitCode !== null
        && stderr.join('').includes(UNKNOWN_MCP_CONFIG_OPTION)
      ) {
        const replacement = restart();
        // Held v2 events belong to the attempt that never ran; the replacement emits its own.
        if (replacement) return await replacement.result;
      }
      releaseUi();
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
      // A teardown xezar itself asked for (`end()`'s watchdog, or a cancel)
      // comes back as 143 because pi handles SIGTERM itself — our own signal,
      // not a pi failure, so it settles on the normal path with a note (#703).
      if (terminatedByXezar && isSignalTerminationExit(exitCode)) {
        onEvent?.({
          type: 'note',
          message: `pi CLI did not exit on its own after close; terminated by xezar (code ${exitCode})`,
        });
        onEvent?.({ type: 'done' });
        // `\n`, like the two return sites around it: #151 made pi join whole
        // messages with a newline for parity with the other runners, and this
        // exit path arrived from #156 while every join here was still `''`.
        return { text: textChunks.join('\n').trim(), toolCalls, tokensUsed, sessionId };
      }
      if (exitCode !== 0 && exitCode !== null) {
        const raw = stderr.join('').trim().split('\n').slice(-3).join(' | ');
        const detail = raw ? ` — ${raw}` : '';
        // Same split as the claude runner (#156): past the flag above, a
        // 128+signal code means something other than xezar signalled pi.
        const message = isSignalTerminationExit(exitCode)
          ? `${foreignSignalExitMessage('pi CLI', exitCode)}${detail}`
          : `pi CLI exited with code ${exitCode}${detail}`;
        onEvent?.({ type: 'error', message });
        throw new Error(message);
      }
      if (!settled) onEvent?.({ type: 'note', message: 'pi RPC session ended before agent_settled' });
      if (tokensUsed === 0) onEvent?.({ type: 'note', message: 'token usage not reported by pi CLI' });
      emitUiEvent({ type: 'session.ended', reason: piUi.stopReason });
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

/**
 * `mcpOverlayPath` is the #342 seam: the adapter's `--mcp-config` flag substitutes for the pi
 * agent directory's own `mcp.json` in its six-file chain, and the file xezar writes there carries
 * that file forward plus a `disabled: true` marker for xezar's own bridge. It is optional so the
 * pure argv shape stays testable without a temp file; `startSession` always supplies it.
 */
export function buildPiArgs(spec: AgentRunSpec, mcpOverlayPath?: string): string[] {
  const args = ['--mode', 'rpc'];
  if (mcpOverlayPath) args.push('--mcp-config', mcpOverlayPath);
  if (spec.sessionId) args.push(spec.resume ? '--session' : '--session-id', spec.sessionId);
  if (spec.systemPrompt) args.push('--append-system-prompt', spec.systemPrompt);
  if (spec.model) args.push('--model', spec.model);
  const tools = piTools(spec.allowedTools ?? [], spec.bashAllowlist);
  if (tools.length > 0) args.push('--tools', tools.join(','));
  const allowlist = bashAllowlistEntries(spec.bashAllowlist);
  if (spec.worktreeRoot) {
    // `--flag=value`: pi reads a separate value that starts with `-` or `@` as a boolean flag.
    // A missing primary root is passed as absent, and the guard then fails closed.
    args.push('--extension', piWorktreeGuardPath(), `--xezar-worktree-root=${spec.worktreeRoot}`);
    if (spec.primaryRoot) args.push(`--xezar-primary-root=${spec.primaryRoot}`);
    if (spec.additionalDirectories?.length) {
      args.push(`--xezar-allowed-roots=${JSON.stringify(spec.additionalDirectories)}`);
    }
  } else if (allowlist.length > 0) {
    // No worktree, so no worktree check: the same extension is loaded for the allowlist alone.
    args.push('--extension', piWorktreeGuardPath());
  }
  // #856: pi has no command-prefix rule, so the extension applies the one Claude Code gives
  // `Bash(<entry>:*)`. Only a non-empty list adds the flag – without one the argv is unchanged.
  if (allowlist.length > 0) args.push(`--xezar-bash-allowlist=${JSON.stringify(allowlist)}`);
  return args;
}

function piWorktreeGuardPath(): string {
  // Source: src/core -> scripts. Published build: dist/core -> scripts. Keeping the extension in
  // the package's existing `scripts` payload lets both layouts resolve the same relative path.
  return resolvePath(dirname(fileURLToPath(import.meta.url)), '../../scripts/pi-worktree-guard.ts');
}

/** The usable entries of a step's `bashAllowlist`: trimmed, blanks dropped (as `buildAllowedTools`). */
function bashAllowlistEntries(bashAllowlist?: string[]): string[] {
  return (bashAllowlist ?? []).map((entry) => entry.trim()).filter(Boolean);
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
        // A `bashAllowlist` keeps bash and the worktree-guard extension restricts it command by
        // command (#856). A list with no usable entry cannot be applied, and fails closed as Claude
        // Code does (`buildAllowedTools` emits no Bash rule for it): bash is removed.
        .filter((tool) => tool !== 'Bash' || !bashAllowlist || bashAllowlist.length === 0 || bashAllowlistEntries(bashAllowlist).length > 0)
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
