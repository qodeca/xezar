import { z } from 'zod';
import { MCP_JOURNAL_PAGE_ROWS, mcpJournalCursorSchema, operationIdSchema } from '@qodeca/xezar-contract';

import { redactDeep } from '../../core/secret-redaction.ts';
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
 * What this is NOT: push. One read when the leader connects, and a next page only because an answer
 * said `hasMore` — no timer, no status poll, no subscription (N-06). Live delivery to a connected
 * client (F-20, `LeaderFeed`) and a model reaction to an event (A-19) are Phase 6.
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

type LeaderEventsContext = McpToolContext & { readonly leaderEvents?: LeaderEventsPort };

export const leaderEventsInputSchema = z
  .object({
    action: z
      .enum(['read', 'ack'])
      .describe(
        'read: the events outstanding since your last acknowledged position, then the current state of the tasks they name. ' +
          'ack: record that you have taken every event up to cursor into account.',
      ),
    cursor: mcpJournalCursorSchema
      .optional()
      .describe(
        'read: replay after this cursor instead of your acknowledged position (optional; it never moves the acknowledgement). ' +
          'ack: required — the nextCursor of a page, or the resumeCursor of a gap.',
      ),
    limit: z.number().int().min(1).max(MCP_JOURNAL_PAGE_ROWS).optional().describe(`read: events per page, at most ${MCP_JOURNAL_PAGE_ROWS}.`),
    operationId: operationIdSchema
      .optional()
      .describe(
        'ack: required — a client-generated key for this acknowledgement (8–128 chars). Reuse it only to repeat the same acknowledgement. read: not accepted, because a read is meant to return the same events again until you ack them.',
      ),
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
  });
export type LeaderEventsInput = z.output<typeof leaderEventsInputSchema>;

const NOT_CONNECTED =
  "leader_events is not connected to this project's event journal; nothing was read or acknowledged.";

export const leaderEventsTool = defineTool({
  name: 'leader_events',
  title: 'Read and acknowledge project events',
  description: [
    "Read this project's significant events (task outcomes, questions, quality gates, human changes, executor availability) since you last acknowledged them, and acknowledge them.",
    'Call read when you connect or reconnect. It returns the outstanding events in order, each with a stable eventId and a standing (current, superseded or unjudged), then the current state of the tasks they name — the state is the authority, an event is history.',
    'When hasMore is true, read again at once; otherwise do not poll — call read again on your next connection.',
    'After you have taken a page into account, ack its nextCursor. Until you do, read returns the same events again, so drop any eventId you already handled. Acknowledging an older cursor changes nothing.',
    'status "gap" means events after your position are no longer retained: nothing is replayed, the current state is included, and you continue by acking resumeCursor.',
  ].join('\n'),
  inputSchema: leaderEventsInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async call(args, ctx) {
    const port = (ctx as LeaderEventsContext).leaderEvents;
    if (!port) return errorResult(NOT_CONNECTED);
    try {
      return args.action === 'ack' ? ack(port, args.cursor!) : read(port, args);
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

function read(port: LeaderEventsPort, args: LeaderEventsInput): McpToolResult {
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
  return textResult(`${headline(answer)}\n${JSON.stringify(structured)}`, structured);
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
