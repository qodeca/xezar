import { z } from 'zod';
import {
  MCP_JOURNAL_MIN_RETENTION_DAYS,
  MCP_JOURNAL_PAGE_BYTES,
  MCP_JOURNAL_PAGE_ROWS,
  MCP_JOURNAL_RETAINED_ROWS,
  STALL_DEADLINE_RATIO,
  STALL_QUIET_MS,
  mcpJournalCursorSchema,
  operationIdSchema,
  type McpLeaderDoorResult,
  type McpLeaderSelfStatus,
} from '@qodeca/xezar-contract';

import { redactDeep } from '../../core/secret-redaction.ts';
import { leaderSetupVerificationLine } from '../../onboarding/leader-setup.ts';
import type { EventJournal } from '../event-journal.ts';
import { McpJournalCursorError } from '../event-journal.ts';
import { reconnect, type LeaderCursors, type ReconnectAnswer, type StateReader } from '../reconnect.ts';
import { defineTool, errorResult, textResult, type McpToolContext, type McpToolResult } from '../tool.ts';

/**
 * `leader_events` (#251): the leader's PULL read of its project's significant events (F-21, A-15,
 * A-21). A thin door over `reconnect.ts`, which owns every rule — this file only chooses the call
 * and shapes the answer:
 *
 *  - `read` is `reconnect()`: the outstanding rows strictly after the leader's acknowledged cursor
 *    (or after an explicit `cursor`, a rewind that never moves the ack), in `journalSeq` order, THEN
 *    the current state of the tasks they name. A cursor whose rows are gone is the journal's own
 *    `cursor_too_old` answer — stated as a gap with the current state beside it, never a partial
 *    replay that would read as "nothing happened in between".
 *  - `ack` is `LeaderCursors.ack()`: monotonic and idempotent, so a duplicate or an older cursor is
 *    a successful no-op, never a rewind.
 *
 * At-least-once, no repeated effect (N-10): a read before the ack returns the same rows again, each
 * with its stable `eventId`, which is how the leader drops a duplicate.
 *
 * #460 § 4 — the guarantee stated exactly, because a compacted leader acts on this text. At-least-once
 * WITHIN RETAINED DURABLE STATE: never exactly-once, and never a promise about deleted or corrupt
 * runtime state. Retention is D-09 B-19 (the newest `MCP_JOURNAL_RETAINED_ROWS`, and nothing younger
 * than `MCP_JOURNAL_MIN_RETENTION_DAYS` days), pages are B-02/B-01, and anything older is the explicit
 * `gap` above, never silence. Reading or receiving a row never advances the ack — only `ack` does
 * (`LeaderCursors.markDelivered` vs `ack`) — and 0.15.0 re-pushes nothing on a timer: a row already
 * delivered in this session is recovered by a READ, which is why the description tells the leader to
 * read after a compaction.
 *
 * What this tool itself is NOT: push. One read when the leader connects, and a next page only
 * because an answer said `hasMore` — no timer, no status poll, no subscription (N-06). Push lives in
 * `LeaderDelivery` (#374/#404) and is the normal path for an ATTACHED leader; `read` is the fallback
 * for a leader that is not attached, and the catch-up after a gap (#439).
 *
 * #450 — the door to push, for the CALLING session only: `attach`, `stop` and `status` call the same
 * `LeaderDelivery` the cockpit's Attach leader and `POST /api/v1/mcp/leader` call. The client is the
 * session's own, derived from what the session showed (`leaderClientOf`), never an argument — the
 * schema stays `.strict()`, so a `client` key is refused. A leader never replaces or detaches a leader
 * of another client, and hosted mode refuses attach and stop. Attach and stop carry an `operationId`,
 * so a reused key replays its receipt — even across a restart that ended the attachment, which is
 * why every attach takes a new one.
 *
 * F-15: rows are scrubbed with this host's secret list on the way out (the journal already scrubs a
 * summary; a subject id is prose a writer chose too). Cursors are never touched: they are the
 * journal's own opaque tokens. F-12 / N-01: a row and a task state carry no account identity, and
 * the journal is the bound project's — a cursor from another project is refused outright.
 */

/** The composed parts the tool reads — built once per project by `startMcpService`. */
export interface LeaderEventsPort {
  readonly journal: EventJournal;
  readonly cursors: LeaderCursors;
  readonly readState: StateReader;
  readonly secretValues: readonly string[];
}

/** #450: the delivery path, for one session — `LeaderDelivery` in production, composed by `startMcpService`. */
export interface LeaderControlPort {
  sessionStatus(sessionKey: string): McpLeaderSelfStatus;
  attachSession(sessionKey: string): Promise<McpLeaderDoorResult>;
  stopSession(sessionKey: string): Promise<McpLeaderDoorResult>;
}

type LeaderEventsContext = McpToolContext & { readonly leaderEvents?: LeaderEventsPort; readonly leaderControl?: LeaderControlPort };

const ACTION_TEXT =
  'read: the events outstanding since your last acknowledged position, then the current state of the tasks they name. ' +
  'ack: record that you have taken every event up to cursor into account. ' +
  'attach: make this session the project’s leader, so events are pushed to it. stop: detach this session. ' +
  'status: this session’s attachment, push capability and delivery state.';
const CURSOR_TEXT =
  'read: replay after this cursor instead of your acknowledged position (optional; it never moves the acknowledgement). ' +
  'ack: required — the cursor a pushed message names, the nextCursor of a page, or the resumeCursor of a gap. Not accepted by attach, stop or status.';
const OPERATION_ID_TEXT =
  'ack, attach and stop: required — a client-generated key for this call (8–128 chars). Use a new one for every call; reuse it only to repeat the same call after a lost answer. ' +
  'read and status: not accepted, because they change nothing you would want replayed.';

export const leaderEventsInputSchema = z
  .object({
    action: z.enum(['read', 'ack', 'attach', 'stop', 'status']).describe(ACTION_TEXT),
    cursor: mcpJournalCursorSchema.optional().describe(CURSOR_TEXT),
    limit: z.number().int().min(1).max(MCP_JOURNAL_PAGE_ROWS).optional().describe(`read: events per page, at most ${MCP_JOURNAL_PAGE_ROWS}.`),
    operationId: operationIdSchema.optional().describe(OPERATION_ID_TEXT),
  })
  .strict()
  .superRefine((args, ctx) => {
    if (args.action === 'ack' && args.cursor === undefined) {
      ctx.addIssue({ code: 'custom', path: ['cursor'], message: 'ack needs cursor' });
    }
    if (args.action === 'ack' && args.limit !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['limit'], message: 'limit does not apply to ack' });
    }
    // D-06 § 5.2 (#264). `ack` writes the leader's position, so it carries an operation id. `read`
    // must NOT: at-least-once delivery means a repeated read deliberately returns the same rows
    // again, and a receipt over it would answer the second read with the receipt instead.
    if (args.action === 'ack' && args.operationId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['operationId'], message: 'ack needs operationId' });
    }
    if (args.action === 'read' && args.operationId !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['operationId'], message: 'operationId does not apply to read' });
    }
    // #450. Attach and stop change who events are pushed to, so they carry an operation id; status
    // changes nothing. None of the three reads a cursor or a page size.
    const door = args.action === 'attach' || args.action === 'stop';
    if (door && args.operationId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['operationId'], message: `${args.action} needs operationId` });
    }
    if (args.action === 'status' && args.operationId !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['operationId'], message: 'operationId does not apply to status' });
    }
    if ((door || args.action === 'status') && args.cursor !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['cursor'], message: `cursor does not apply to ${args.action}` });
    }
    if ((door || args.action === 'status') && args.limit !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['limit'], message: `limit does not apply to ${args.action}` });
    }
  });
export type LeaderEventsInput = z.output<typeof leaderEventsInputSchema>;

const NOT_CONNECTED =
  "leader_events is not connected to this project's event journal; nothing was read, acknowledged, attached or detached. Call `health` to see whether xezar is running for this project. Report this to the person; do not fall back to the cockpit.";

export const leaderEventsTool = defineTool({
  name: 'leader_events',
  title: 'Attach, read and acknowledge project events',
  description: [
    "Attach this session as the project's leader so xezar pushes its significant events to it (task outcomes, questions, quality gates, human changes, executor availability), and read and acknowledge those events.",
    'attach: make this session the leader xezar pushes events to – a `<channel source="xezar">` message in Claude Code, a started turn in Codex or pi. The client is this session’s own; you never name it. Call it once per session with a new operationId, and again when status says you are not attached. stop: detach this session. status: whether this session is attached and can receive pushes, the delivery cursors, and what blocks delivery. An OpenCode leader is attached by a person in Settings → MCP connection.',
    'Each pushed message names the cursor of its last event. Once you have taken the events into account, ack that cursor. No read is needed.',
    'Leader setup has four separate states: files prepared (a project snippet only), connected (a real MCP tool call reached this project), attached (this session owns the attachment), and delivery verified (a real pushed event or an attached-session replay check). Never call a snippet ready. After a restart, status and attach must be repeated with a new operationId before delivery is verified again.',
    'read is the fallback: call it when you connect or reconnect, when you are not attached, or when a pushed message names a gap. It returns the outstanding events in order, each with a stable eventId and a standing (current, superseded or unjudged), then the current state of the tasks they name — the state is the authority, an event is history.',
    'When hasMore is true, read again at once; otherwise do not poll.',
    'After you have taken a page into account, ack its nextCursor. Until you do, read returns the same events again, so drop any eventId you already handled. Acknowledging an older cursor changes nothing.',
    'status "gap" means events after your position are no longer retained: nothing is replayed, the current state is included, and you continue by acking resumeCursor.',
    // #460 § 2: the advisory is only safe if the leader is told, in the same breath, what it does
    // NOT mean. A reader that treats this row as a failure would cancel working tasks.
    `task.stalled is an advisory observation: no transcript activity for ${STALL_QUIET_MS / 60_000} minutes, or at least ${Math.round(STALL_DEADLINE_RATIO * 100)}% of a finite step timeout used. It does not prove a deadlock and does not stop the task. Read the task before deciding whether to steer or cancel it. task.resumed says activity came back.`,
    // #460 § 4, verbatim: the one recovery a compacted leader must be told, because after a
    // compaction it cannot know which pushed messages it still holds. Read replays what was pushed
    // and never acked, so the recovery is a read — not a re-push, and not a poll.
    'After context compaction, call leader_events with action read and no cursor before relying on prior pushes. It replays retained events after your last explicit acknowledgement, including events pushed but not acknowledged. Read every page using nextCursor while hasMore is true. Deduplicate by eventId, reconcile current task state, then acknowledge only the events you have accounted for. A transport receipt is not an acknowledgement. Already acknowledged events are not replayed by default; use a retained earlier cursor if you deliberately need history. If the journal reports a gap, reconcile the returned current state before acknowledging resumeCursor. Do not poll while idle.',
    // #460 § 4: the guarantee stated as it is, not stronger. The numbers are D-09 B-19/B-01/B-02.
    `Delivery is at-least-once within retained durable state, not exactly-once: xezar retains at least the newest ${MCP_JOURNAL_RETAINED_ROWS} events and evicts none younger than ${MCP_JOURNAL_MIN_RETENTION_DAYS} days, and a page carries at most ${MCP_JOURNAL_PAGE_ROWS} events or ${MCP_JOURNAL_PAGE_BYTES} bytes. Events outside that are reported as an explicit gap, never as silence. Acknowledgement is cumulative, monotonic and idempotent, and only your ack moves it: reading or receiving an event does not. Nothing already delivered to this session is pushed again on a timer.`,
  ].join('\n'),
  inputSchema: leaderEventsInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async call(args, ctx) {
    const { leaderControl, sessionKey } = ctx as LeaderEventsContext;
    if (args.action === 'attach' || args.action === 'stop' || args.action === 'status') {
      if (!leaderControl || sessionKey === undefined) return errorResult(NOT_CONNECTED);
      if (args.action === 'status') return statusResult(leaderControl.sessionStatus(sessionKey));
      return doorResult(await (args.action === 'attach' ? leaderControl.attachSession(sessionKey) : leaderControl.stopSession(sessionKey)));
    }
    const port = (ctx as LeaderEventsContext).leaderEvents;
    if (!port) return errorResult(NOT_CONNECTED);
    try {
      const status = leaderControl && sessionKey !== undefined ? leaderControl.sessionStatus(sessionKey) : undefined;
      return args.action === 'ack' ? ack(port, args.cursor!) : read(port, args, status);
    } catch (err) {
      if (err instanceof McpJournalCursorError) {
        return errorResult(`${err.rejection.message}. Nothing was ${args.action === 'ack' ? 'acknowledged' : 'read'}.`, {
          ...err.rejection,
        });
      }
      throw err;
    }
  },
});

const CLIENT_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode', pi: 'pi' } as const;

function statusResult(status: McpLeaderSelfStatus): McpToolResult {
  return textResult(`${statusHeadline(status)}\n${leaderSetupVerificationLine(status)}\n${JSON.stringify(status)}`, status);
}

/** The authoritative first line of a status (D-05). */
function statusHeadline(status: McpLeaderSelfStatus): string {
  if (!status.available) return `xezar cannot answer for this project's event delivery: ${status.reason}.`;
  const { leader, self, blocker } = status;
  if (leader !== null && self.attached) {
    const blocked = blocker === null ? '' : ` Blocked: ${blocker.message} Fix: ${blocker.fix}`;
    return `This session is attached as the project leader (${CLIENT_NAMES[leader.client]}); events are pushed to it.${blocked}`;
  }
  if (leader !== null) {
    const name = CLIENT_NAMES[leader.client];
    return `${/^[AEIOU]/.test(name) ? 'An' : 'A'} ${name} leader is attached to this project, not this session; events are pushed to it, not to you.`;
  }
  if (status.pushUnavailable !== null) return `xezar cannot push events to this session: ${status.pushUnavailable.message} Read events with leader_events.`;
  return 'This session is not attached, so events are not pushed to it. Call leader_events with action attach; until then, read events with leader_events.';
}

function doorResult(result: McpLeaderDoorResult): McpToolResult {
  if (!result.ok) {
    const verb = result.action === 'attach' ? 'attached' : 'detached';
    return errorResult(
      `Nothing was ${verb}: ${result.message} ${result.fix}\n${leaderSetupVerificationLine(result.status)}\n${JSON.stringify(result)}`,
      result,
    );
  }
  const status = result.status;
  const name = status.available && status.leader !== null ? CLIENT_NAMES[status.leader.client] : undefined;
  const headline =
    result.outcome === 'attached'
      ? `Attached this session as the project leader (${name}). Events are pushed to it from now on; ack each pushed message with the cursor it names.`
      : result.outcome === 'already-attached'
        ? `This session is already attached as the project leader (${name}); nothing changed.`
        : result.outcome === 'stopped'
          ? 'Detached this session. Events are kept in the journal and no longer pushed; read them with leader_events.'
          : 'No leader is attached; nothing changed.';
  return textResult(`${headline}\n${leaderSetupVerificationLine(status)}\n${JSON.stringify(result)}`, result);
}

function read(port: LeaderEventsPort, args: LeaderEventsInput, status?: McpLeaderSelfStatus): McpToolResult {
  const answer = reconnect({
    journal: port.journal,
    cursors: port.cursors,
    readState: port.readState,
    ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
  });
  // D-05 § 6.6: the rows are handed to the client now, so they count as delivered — not acked.
  const last = answer.status === 'ok' ? answer.events.at(-1)?.row.journalSeq : undefined;
  if (last !== undefined) port.cursors.markDelivered(last);
  const position = port.cursors.position();
  const structured = shape(answer, position, port.secretValues);
  return textResult(`${headline(answer)}\n${leaderSetupVerificationLine(status, { replayChecked: status?.available === true && status.self.attached })}\n${JSON.stringify(structured)}`, structured);
}

function ack(port: LeaderEventsPort, cursor: string): McpToolResult {
  const result = port.cursors.ack(cursor);
  const structured = { status: result.status, ackedSeq: result.ackedSeq, position: port.cursors.position() };
  const text =
    result.status === 'acked'
      ? `Acknowledged every event through #${result.ackedSeq}.`
      : `Nothing changed: events through #${result.ackedSeq} were already acknowledged.`;
  return textResult(`${text}\n${JSON.stringify(structured)}`, structured);
}

function shape(answer: ReconnectAnswer, position: ReturnType<LeaderCursors['position']>, secretValues: readonly string[]) {
  const common = { state: answer.state, position, fresh: answer.fresh, journalEpoch: answer.journalEpoch };
  if (answer.status === 'cursor_too_old') {
    const { gap } = answer;
    return {
      status: 'gap' as const,
      gap: { oldestSeq: gap.oldestSeq, latestSeq: gap.latestSeq, resumeCursor: gap.resumeCursor, recovery: gap.recovery },
      ...common,
    };
  }
  return {
    status: 'ok' as const,
    events: answer.events.map(({ row, standing }) => ({ ...redactDeep(row, secretValues), standing })),
    nextCursor: answer.nextCursor,
    hasMore: answer.hasMore,
    ...common,
  };
}

/** The authoritative first line (D-05: the text block is what a client must be able to act on). */
function headline(answer: ReconnectAnswer): string {
  if (answer.status === 'cursor_too_old') {
    const { oldestSeq, latestSeq } = answer.gap;
    const retained = oldestSeq === null ? 'the journal holds no events' : `the journal holds #${oldestSeq}–#${latestSeq}`;
    return `GAP: events after your position are no longer retained (${retained}). Nothing was replayed. Read the current state below, then ack resumeCursor.`;
  }
  if (answer.events.length === 0) return 'No outstanding events.';
  const first = answer.events[0]!.row.journalSeq;
  const last = answer.events.at(-1)!.row.journalSeq;
  const more = answer.hasMore ? ' More are retained: read again now.' : '';
  return `${answer.events.length} outstanding event(s), #${first}–#${last}.${more} Ack nextCursor once you have taken them into account.`;
}
