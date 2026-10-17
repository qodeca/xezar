import type { EventDispatch, ReactionAdapter } from '../event-controller.ts';
import { renderChannelContent } from './claude-code.ts';

/**
 * Qwen Code and push delivery (#1045). The reaction adapter for a Qwen Code leader the person started
 * themselves. The evidence is `docs/research/qwen-code-leader-push-2026-10-16.md` (#1043).
 *
 * WHAT IT DOES. `deliver` hands one dispatch to the owner MCP session's own bridge as a `leader/push`,
 * exactly as for Claude Code; the bridge sends it into the Qwen Code session's own inbox and confirms
 * only on Qwen Code's `delivered` receipt (`qwen-messaging.ts`). Qwen Code then submits it to the model
 * at once when the session is idle, and after the running turn when it is busy. The adapter opens no
 * transport of its own, and xezar starts no Qwen Code process.
 *
 * DELIVERY, NOT REACTION. `delivered` means Qwen Code's input queue took the message — delivery, so
 * `deliveredSeq` advances. The model's answer stays in the person's own Qwen Code session, which xezar
 * never reads, so `reactedSeq` stays 0, as for Claude Code. `ackedSeq` advances when the leader
 * acknowledges with `leader_events`, which every pushed message asks it to.
 *
 * NO NODE, NO PROCESS, NO ENVIRONMENT. Like the Claude Code adapter, this file imports no `node:*`
 * module, spawns nothing and reads no environment variable; the socket lives in the bridge.
 */

export interface QwenCodeInboxAdapterOptions {
  readonly projectId: string;
  /** xezar's role instruction, carried in every message: it is the only context this leader gets. */
  readonly roleInstruction: string;
  /** Push one message down the owner session's bridge; resolves on Qwen Code's `delivered` receipt. */
  readonly push: (content: string, signal: AbortSignal) => Promise<void>;
  /** Is the owner session's connection still there? A non-model liveness check. */
  readonly alive: () => boolean;
  /** The newest row the leader acknowledged with `leader_events`. */
  readonly acknowledged: () => number;
  /** One heartbeat: how long a delivered-but-unacknowledged row waits before it is a blocker. */
  readonly heartbeatMs: number;
  /** Test seam. Production uses `Date.now`. */
  readonly now?: () => number;
  /** Test seam for the wait after a rate refusal. Production uses an abortable timer. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface QwenCodeInboxBlocker {
  readonly code: 'qwen-push-unacknowledged' | 'qwen-push-held';
  readonly message: string;
  readonly fix: string;
}

export const QWEN_PUSH_UNACKNOWLEDGED_MESSAGE =
  'xezar pushed events into the attached Qwen Code session, and Qwen Code took them, but the leader has not acknowledged them yet. Qwen Code runs a received message after the current turn, so a busy leader acknowledges later. Nothing is lost: the events stay in the journal.';
export const QWEN_PUSH_UNACKNOWLEDGED_FIX =
  'If the leader is working, nothing is needed. Otherwise check that the Qwen Code session is still open and not waiting on a prompt of its own. Until then, read events with leader_events.';

export const QWEN_PUSH_HELD_MESSAGE =
  'The attached Qwen Code session does not take xezar\'s messages at once: it holds them for your approval, or refuses them. xezar stopped sending, so the session does not fill with copies. Nothing is lost: the events stay in the journal.';
export const QWEN_PUSH_HELD_FIX =
  'In Qwen Code, set agents.crossSessionInbound so messages from xezar are taken (or remove the setting), then attach the leader again. Until then, read events with leader_events.';

/**
 * A receipt that is an answer, not a hiccup: Qwen Code holds the message for the person's approval,
 * or refuses it, because of its own `agents.crossSessionInbound` setting. Sending again would only
 * queue more copies of the same event (#1067 review), so it stops pushes until the next attach.
 * The words are those of `QwenMessaging`, whose error text crosses the bridge as plain text.
 */
const LASTING_REFUSAL = /Qwen Code did not take the message \((held|refused)\b/;

/**
 * xezar's own pacing (`QwenMessenger`): the bridge refuses at once and says when the next send is
 * free. The adapter waits that long INSIDE this attempt, under its abort signal, and tries again,
 * so a burst of events is not pushed back to the 30 s heartbeat (#1067 review). Bounded: at most
 * `RATE_RETRIES` waits of at most `RATE_WAIT_CAP_MS` each, well inside one attempt.
 */
const RATE_REFUSAL = /the next send is free in (\d+) ms/;
const RATE_RETRIES = 3;
const RATE_WAIT_CAP_MS = 5_000;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class QwenCodeInboxAdapter implements ReactionAdapter {
  readonly projectId: string;
  readonly #opts: QwenCodeInboxAdapterOptions;
  readonly #now: () => number;
  #outstanding: { seq: number; at: number }[] = [];
  #closed = false;
  #refusedWith: 'held' | 'refused' | undefined;

  constructor(opts: QwenCodeInboxAdapterOptions) {
    this.#opts = opts;
    this.projectId = opts.projectId;
    this.#now = opts.now ?? Date.now;
  }

  /** One message per dispatch, oldest row first. Resolves on `delivered`; rejects otherwise, so the controller retries. */
  async deliver(dispatch: EventDispatch, signal: AbortSignal): Promise<{ handedThrough: number | null }> {
    if (dispatch.projectId !== this.projectId) {
      throw new Error(`Qwen Code adapter for project ${this.projectId} refused a dispatch for another project`);
    }
    const rows = dispatch.events;
    if (rows.length === 0 && dispatch.recovery === undefined) return { handedThrough: null };
    if (this.#refusedWith !== undefined) {
      throw new Error(`the Qwen Code session ${this.#refusedWith} xezar's last message, so xezar sends nothing more until the leader attaches again`);
    }
    const content = renderChannelContent(dispatch, rows, this.#opts.roleInstruction);
    for (let retry = 0; ; retry++) {
      try {
        await this.#opts.push(content, signal);
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const lasting = LASTING_REFUSAL.exec(message);
        if (lasting) this.#refusedWith = lasting[1] as 'held' | 'refused';
        const rate = RATE_REFUSAL.exec(message);
        if (!rate || retry >= RATE_RETRIES || signal.aborted) throw err;
        await (this.#opts.sleep ?? abortableSleep)(Math.min(Number(rate[1]) + 50, RATE_WAIT_CAP_MS), signal);
      }
    }
    const lastSeq = rows.at(-1)?.journalSeq ?? null;
    if (lastSeq !== null) {
      this.#prune();
      const known = new Set(this.#outstanding.map((row) => row.seq));
      const at = this.#now();
      for (const row of rows) {
        if (row.journalSeq > this.#opts.acknowledged() && !known.has(row.journalSeq)) this.#outstanding.push({ seq: row.journalSeq, at });
      }
    }
    return { handedThrough: lastSeq };
  }

  async heartbeat(_signal: AbortSignal): Promise<void> {
    if (!this.#opts.alive()) throw new Error('the Qwen Code MCP session that owns this project has gone away');
  }

  close(): void {
    this.#closed = true;
  }

  status(): { blocker?: QwenCodeInboxBlocker } {
    if (this.#closed) return {};
    if (this.#refusedWith !== undefined) return { blocker: { code: 'qwen-push-held', message: QWEN_PUSH_HELD_MESSAGE, fix: QWEN_PUSH_HELD_FIX } };
    this.#prune();
    const oldest = this.#outstanding[0];
    if (oldest && this.#now() - oldest.at >= this.#opts.heartbeatMs) {
      return { blocker: { code: 'qwen-push-unacknowledged', message: QWEN_PUSH_UNACKNOWLEDGED_MESSAGE, fix: QWEN_PUSH_UNACKNOWLEDGED_FIX } };
    }
    return {};
  }

  #prune(): void {
    const acked = this.#opts.acknowledged();
    this.#outstanding = this.#outstanding.filter((row) => row.seq > acked);
  }
}
