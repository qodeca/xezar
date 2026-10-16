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
}

export interface QwenCodeInboxBlocker {
  readonly code: 'qwen-push-unacknowledged';
  readonly message: string;
  readonly fix: string;
}

export const QWEN_PUSH_UNACKNOWLEDGED_MESSAGE =
  'xezar pushed events into the attached Qwen Code session, and Qwen Code took them, but the leader has not acknowledged them yet. Qwen Code runs a received message after the current turn, so a busy leader acknowledges later. Nothing is lost: the events stay in the journal.';
export const QWEN_PUSH_UNACKNOWLEDGED_FIX =
  'If the leader is working, nothing is needed. Otherwise check that the Qwen Code session is still open and not waiting on a prompt of its own. Until then, read events with leader_events.';

export class QwenCodeInboxAdapter implements ReactionAdapter {
  readonly projectId: string;
  readonly #opts: QwenCodeInboxAdapterOptions;
  readonly #now: () => number;
  #outstanding: { seq: number; at: number }[] = [];
  #closed = false;

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
    await this.#opts.push(renderChannelContent(dispatch, rows, this.#opts.roleInstruction), signal);
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
