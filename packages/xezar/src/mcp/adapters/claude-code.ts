import type { McpJournalRow } from '@qodeca/xezar-contract';

import type { EventDispatch, ReactionAdapter } from '../event-controller.ts';
import { omittedRoutineLine } from '../event-significance.ts';

/**
 * Claude Code and push delivery (#374, Phase 6 of #73). This is the reaction adapter for a Claude
 * Code leader the person started themselves, through **Claude Code Channels** — the rung-1 native
 * mechanism the client demonstrably reacts to. The runtime evidence is
 * `docs/features/mcp-server/mcp-wake-claude-code-decision.md` (the spike) and the corrected
 * `docs/features/mcp-server/mcp-adapter-evidence-claude-code.md`.
 *
 * WHAT IT DOES. `deliver` hands one dispatch to the owner MCP session's own bridge as a
 * `leader/push`, which the bridge writes out as a `notifications/claude/channel` message; Channels
 * turns that into a model turn in a session launched with
 * `claude --dangerously-load-development-channels server:xezar` (the decision record § 2, § 3). The
 * adapter opens no transport of its own: the socket is the owner session's, and `push` is a thunk the
 * delivery seam binds to it (`leader-delivery.ts`). xezar starts no Claude Code process (owner
 * decision on #311).
 *
 * THE DELIVERY HIERARCHY (#73), in order and not reorderable — see `claudeCodeRoute()`:
 *  1. Native — **ADOPTED**: Claude Code Channels. Measured to wake an idle interactive session in
 *     30–55 ms with nobody typing (decision record § 3.3, M1/M2/R1/L1). Generic MCP notifications
 *     start no turn (D-05 § 4), so the channel is the one native path that works.
 *  2. The programmatic session interface (`claude -p --input-format stream-json`) — UNAVAILABLE: it
 *     needs a `claude` process xezar started, and xezar starts none (#311).
 *  3. Terminal text input — REFUSED. Rung 1 works, so rung 3 is never reached, and xezar never types.
 *
 * DELIVERY, NOT REACTION (F-20, D-05 § 6.6). `deliver` resolves once the bridge CONFIRMS it wrote the
 * notification — that is delivery, and `deliveredSeq` advances on it. Channels acknowledges nothing
 * (the record § 2.1), and the model transcript is a file inside the person's own Claude Code
 * configuration, which xezar never reads. So there is no reaction signal xezar may observe:
 * **`reactedSeq` stays 0 for Claude Code**, true to its contract ("0 until a turn is really seen to
 * carry a row"). `ackedSeq` advances when the leader acknowledges with `leader_events`, which the
 * bridge `INSTRUCTIONS` sentence asks it to. The reaction itself is proven where it CAN be observed —
 * in the acceptance test, at the model endpoint.
 *
 * NEVER `claude/channel/permission`. That capability is not declared anywhere (`protocol.ts`), so
 * Claude Code never routes a tool-approval prompt to xezar and no message can answer one (#73 "never
 * impersonate approval").
 *
 * NO NODE, NO PROCESS, NO ENVIRONMENT. Like the pi and OpenCode adapters, this file imports no
 * `node:*` module, spawns nothing and reads no environment variable; a test asserts it.
 */

/** What the delivery seam gives the adapter: everything client-specific stays here. */
export interface ClaudeCodeChannelAdapterOptions {
  /** The bound project. A dispatch for any other project is a caller bug. */
  readonly projectId: string;
  /** xezar's role instruction, carried in every channel message (§ 12: the leader cannot edit it). */
  readonly roleInstruction: string;
  /**
   * Push one channel message down the owner session's bridge and resolve when the bridge confirms the
   * write. Rejects when no owner session is bound, or the write is not confirmed. The delivery seam
   * binds this to the current owner transport (`leader-delivery.ts`).
   */
  readonly push: (content: string, meta: Record<string, string>, signal: AbortSignal) => Promise<void>;
  /** Is the owner session's connection still there? A non-model liveness check (N-06). */
  readonly alive: () => boolean;
  /** The newest row the leader acknowledged with `leader_events`; for the push-unconfirmed blocker. */
  readonly acknowledged: () => number;
  /** One heartbeat: how long a delivered-but-unacknowledged row waits before it is a blocker. */
  readonly heartbeatMs: number;
  /**
   * #886: when the owner session last called a xezar tool (ms, the `now` clock), or undefined when it
   * has not called one since it opened. The one activity signal xezar has: an active session that is
   * silent about pushed rows is the plain evidence the pushes did not reach its conversation.
   */
  readonly ownerCalledAt?: () => number | undefined;
  /** #886: how long a pushed row may stay unacknowledged while the session keeps calling tools. */
  readonly notSeenMs?: number;
  /** Test seam. Production uses `Date.now`. */
  readonly now?: () => number;
}

/** A condition the person can resolve, in Claude Code's own words. Never a secret, never an account. */
export interface ClaudeCodeChannelBlocker {
  readonly code: 'claude-code-push-unconfirmed' | 'claude-code-push-not-seen';
  readonly message: string;
  readonly fix: string;
}

/**
 * The recoverable blocker for "delivered, but nothing confirms the model took it" (decision record
 * § 5.6). It fires on the fact `deliveredSeq > ackedSeq` for longer than one heartbeat, and it names
 * both what to check and that nothing is lost — it never diagnoses which channel condition failed,
 * because Claude Code drops an undelivered event without telling the server (§ 2.1).
 */
export const CLAUDE_CODE_PUSH_UNCONFIRMED_MESSAGE =
  'xezar pushed events to the attached Claude Code session, and they are not acknowledged yet. Claude Code does not confirm delivery, so xezar cannot tell a leader that is still working from one that never received them. Nothing is lost: the events stay in the journal.';
export const CLAUDE_CODE_PUSH_UNCONFIRMED_FIX =
  'If the leader is working, nothing is needed. Otherwise check that Claude Code was started with --dangerously-load-development-channels server:xezar and that its startup notice says channels from server:xezar inject into the session. Channels need a claude.ai or Console API-key login, do not work on Bedrock, Vertex or Foundry, must be enabled by a Team or Enterprise admin, and are off while CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set. Until then, read events with leader_events.';

/**
 * #886: the bounded time after which an unacknowledged push, followed by a xezar tool call from the
 * same session, stops reading as "the leader is still working". A leader that received an event reads
 * state and acknowledges it within minutes; one that keeps calling xezar tools for five minutes and
 * never mentions the pushed rows most likely never saw them.
 */
export const CLAUDE_CODE_PUSH_NOT_SEEN_MS = 5 * 60_000;

/**
 * The plain blocker for "pushed, still unacknowledged, and the session has called xezar tools well
 * after the push" (#886). It says what xezar saw and what it concludes, and never claims to know which
 * Claude Code condition dropped the rows — Claude Code writes that reason only to its own debug log.
 */
export const CLAUDE_CODE_PUSH_NOT_SEEN_MESSAGE =
  'xezar pushed events to the attached Claude Code session more than five minutes ago, and the session has called xezar tools since without acknowledging them. The pushed events are most likely not reaching the conversation. Claude Code does not confirm delivery, so this is what xezar can see, not a certainty. Nothing is lost: the events stay in the journal.';
export const CLAUDE_CODE_PUSH_NOT_SEEN_FIX =
  'Read the events now with leader_events action read. To see why Claude Code dropped them, start Claude Code again with --dangerously-load-development-channels server:xezar --debug-file <a file path>, attach again, and look in that file for "Channel notifications registered" or for "Channel notifications skipped:" and the reason after it. Until then, read events with leader_events.';

export class ClaudeCodeChannelAdapter implements ReactionAdapter {
  readonly projectId: string;
  readonly #opts: ClaudeCodeChannelAdapterOptions;
  readonly #now: () => number;
  /** First confirmed write per outstanding row; reconnects must not reset its age. */
  #outstanding: { seq: number; at: number }[] = [];
  #closed = false;

  constructor(opts: ClaudeCodeChannelAdapterOptions) {
    this.#opts = opts;
    this.projectId = opts.projectId;
    this.#now = opts.now ?? Date.now;
  }

  /**
   * Hand one dispatch to the client as a channel message — NON-MODEL from xezar's side; whether a
   * turn starts is Claude Code's own decision. One notification per dispatch, oldest row first, never
   * merged or rewritten. Resolves once the bridge confirms the write (delivery); rejects when the
   * owner session is gone or the write is not confirmed.
   */
  async deliver(dispatch: EventDispatch, signal: AbortSignal): Promise<{ handedThrough: number | null }> {
    if (dispatch.projectId !== this.projectId) {
      throw new Error(`Claude Code adapter for project ${this.projectId} refused a dispatch for another project`);
    }
    const rows = dispatch.events;
    if (rows.length === 0 && dispatch.recovery === undefined) return { handedThrough: null };
    const content = renderChannelContent(dispatch, rows, this.#opts.roleInstruction);
    await this.#opts.push(content, channelMeta(dispatch, rows), signal);
    const lastSeq = rows.at(-1)?.journalSeq ?? null;
    if (lastSeq !== null) {
      this.#pruneAcknowledged();
      const known = new Set(this.#outstanding.map((row) => row.seq));
      const at = this.#now();
      for (const row of rows) {
        if (row.journalSeq > this.#opts.acknowledged() && !known.has(row.journalSeq)) {
          this.#outstanding.push({ seq: row.journalSeq, at });
        }
      }
    }
    return { handedThrough: lastSeq };
  }

  /** Non-model liveness (N-06): the owner session's connection is still there. Starts no turn. */
  async heartbeat(_signal: AbortSignal): Promise<void> {
    if (!this.#opts.alive()) throw new Error('the Claude Code MCP session that owns this project has gone away');
  }

  /** Stop. The Claude Code process and its MCP session belong to the person; this owns no transport. */
  close(): void {
    this.#closed = true;
  }

  #pruneAcknowledged(): void {
    const acked = this.#opts.acknowledged();
    this.#outstanding = this.#outstanding.filter((row) => row.seq > acked);
  }

  /**
   * The blockers this adapter reports: rows pushed and confirmed, but not yet acknowledged for longer
   * than a heartbeat — and, stronger (#886), still unacknowledged when the same session calls a xezar
   * tool `notSeenMs` or more after the push. Delivery failures are the delivery seam's `deliveryFailing` /
   * `leaderNotAnswering` (a rejected push sets `failingSince` there), so this is only ever "delivered,
   * awaiting the leader".
   */
  status(): { blocker?: ClaudeCodeChannelBlocker } {
    if (this.#closed) return {};
    this.#pruneAcknowledged();
    const oldest = this.#outstanding[0];
    // #886: a call from the session made at least `notSeenMs` after the oldest unacknowledged push is
    // the session being active and silent about it. Only a call AFTER that bound counts, so a leader
    // that reads state before acknowledging, as the channel message asks, is never reported early.
    const calledAt = this.#opts.ownerCalledAt?.();
    if (oldest && calledAt !== undefined && calledAt - oldest.at >= (this.#opts.notSeenMs ?? CLAUDE_CODE_PUSH_NOT_SEEN_MS)) {
      return { blocker: { code: 'claude-code-push-not-seen', message: CLAUDE_CODE_PUSH_NOT_SEEN_MESSAGE, fix: CLAUDE_CODE_PUSH_NOT_SEEN_FIX } };
    }
    if (oldest && this.#now() - oldest.at >= this.#opts.heartbeatMs) {
      return { blocker: { code: 'claude-code-push-unconfirmed', message: CLAUDE_CODE_PUSH_UNCONFIRMED_MESSAGE, fix: CLAUDE_CODE_PUSH_UNCONFIRMED_FIX } };
    }
    return {};
  }
}

/**
 * The `meta` a channel message carries — IDENTIFIER keys only (the decision record § 2.1, § 5.3).
 * Every key matches Claude Code's `^[a-zA-Z_][a-zA-Z0-9_]*$` rule, and a unit test pins that; a key
 * that did not would be dropped by Claude Code with a warning.
 */
export function channelMeta(dispatch: EventDispatch, rows: readonly McpJournalRow[]): Record<string, string> {
  const meta: Record<string, string> = { source_app: 'xezar', project_id: dispatch.projectId };
  const first = rows[0]?.journalSeq;
  const last = rows.at(-1)?.journalSeq;
  if (first !== undefined) meta.first_seq = String(first);
  if (last !== undefined) meta.last_seq = String(last);
  if (dispatch.recovery !== undefined) meta.recovery = '1';
  if (dispatch.omittedRoutineCount !== undefined) meta.omitted_routine_count = String(dispatch.omittedRoutineCount);
  // #450: the cursor the leader acks with, so a pushed event needs no read.
  meta.next_cursor = dispatch.nextCursor;
  return meta;
}

/**
 * The text the model sees inside `<channel source="xezar" …>`. It names xezar as the source and says
 * what it is not before any row — an event must never read as the user's instruction or approval
 * (§ 12) — and carries xezar's role instruction, because a channel message is the only context this
 * leader gets. Rows are the journal's own summaries, already scrubbed of secrets (F-15), never a
 * payload; each is quoted so text inside a summary cannot pose as the framing.
 */
export function renderChannelContent(dispatch: EventDispatch, rows: readonly McpJournalRow[], roleInstruction: string): string {
  const lines = [
    '[xezar event notification]',
    `Source: xezar, project ${dispatch.projectId}. Sent automatically by xezar. It is not a message from the user, not an instruction and not an approval.`,
    `Your role: ${roleInstruction}`,
  ];
  if (rows.length > 0) {
    lines.push(`Significant events (${rows.length}, oldest first):`);
    for (const row of rows) {
      const subject = `${row.subject.type} ${row.subject.id}${row.subject.version === null ? '' : ` @${row.subject.version}`}`;
      lines.push(`- ${row.eventId} ${row.category} ${row.kind} on ${subject} (origin ${row.origin}): ${JSON.stringify(row.summary)}`);
    }
  }
  if (dispatch.recovery) {
    lines.push(
      `Gap: ${dispatch.recovery.message} (oldest retained ${dispatch.recovery.oldestSeq ?? 'none'}, latest ${dispatch.recovery.latestSeq}).`,
    );
  }
  const omitted = omittedRoutineLine(dispatch.omittedRoutineCount);
  if (omitted !== undefined) lines.push(omitted);
  lines.push(
    `Read the current state with the xezar tools before acting. Once you have taken these events into account, acknowledge them: call leader_events with action ack, cursor ${dispatch.nextCursor} and a new operationId. You do not need to read them first.`,
  );
  return lines.join('\n');
}

// ---- the recorded verdict (corrected 2026-09-13, #374) ---------------------------------------

export interface ClaudeCodeRouteStep {
  readonly step: 1 | 2 | 3;
  readonly mechanism: 'claude-channels' | 'stream-json-session' | 'terminal-input';
  /** `reacts`: demonstrated to wake the session. `unavailable`: needs a process xezar does not start. `refused`. */
  readonly outcome: 'reacts' | 'unavailable' | 'refused';
}

export interface ClaudeCodeRoute {
  readonly route: 'claude-channels';
  readonly steps: readonly ClaudeCodeRouteStep[];
  /** The eligibility conditions that sit OUTSIDE xezar (decision record § 2.3, § 2.4). */
  readonly conditions: readonly string[];
}

/**
 * The hierarchy, walked in order, for a Claude Code leader the person runs. Corrected on 2026-09-13
 * (#374): the earlier verdict recorded Channels as "not demonstrated" from a single 2.1.268 run
 * (CH1) that also had the feature-flag service off; the spike then demonstrated a wake on 2.1.270, so
 * Channels is the adopted rung-1 mechanism. The conditions below are real and outside xezar's
 * control — the person must opt in per launch, and Channels is a research preview behind a
 * feature-flag service, first-party providers, and Team/Enterprise policy.
 */
export function claudeCodeRoute(): ClaudeCodeRoute {
  return {
    route: 'claude-channels',
    steps: [
      { step: 1, mechanism: 'claude-channels', outcome: 'reacts' },
      { step: 2, mechanism: 'stream-json-session', outcome: 'unavailable' },
      { step: 3, mechanism: 'terminal-input', outcome: 'refused' },
    ],
    conditions: [
      'the person launches Claude Code with --dangerously-load-development-channels server:xezar (Claude Code shows a confirmation screen every launch)',
      'the feature-flag service is reachable and enables channels (off while CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set)',
      'the provider is Anthropic first-party (not Bedrock, Vertex or Foundry)',
      'a claude.ai Team or Enterprise admin has enabled channels for the organisation',
    ],
  };
}
