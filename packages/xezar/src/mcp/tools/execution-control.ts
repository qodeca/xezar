import {
  attachmentInputSchema,
  mcpExpectedVersionSchema,
  runIdParamSchema,
  staleVersionRejectionSchema,
  type RunHistoryPage,
  type StaleVersionRejection,
} from '@qodeca/xezar-contract';
import { hc } from 'hono/client';
import { z } from 'zod';
import type { AppType } from '../../server/app-type.ts';
import { MCP_ORIGIN, McpServiceAdapter, type GetRunValue, type ServiceDispatch } from '../service-adapter.ts';
import { staleRejectionIn } from '../stale-write.ts';
import { defineTool, errorResult, textResult, type McpToolContext, type McpToolResult } from '../tool.ts';

/**
 * Execution control and session messaging for the bound project's own tasks (#94, F-08, F-09,
 * M-03, M-04; inventory I-032, I-034–I-040).
 *
 * WHAT IT CAN TARGET. A task of the project this connection is bound to, named by its run id —
 * and nothing else. Every action first reads the task through the shared service adapter (#89),
 * whose scope is the connection's project, so another project's task is a 404 before anything
 * is dispatched. There is no argument for a process id, a signal, a command or a path, and this
 * module starts or signals no process itself: every effect is one of the cockpit's own routes,
 * and the RunManager behind that route is the only thing that ever touches an agent process.
 * F-08 is explicit that a generic "kill PID" does not meet the boundary; none exists here.
 *
 * THE SAME STATE MACHINE AS THE COCKPIT. Each action is offered in exactly the states the
 * cockpit offers it (`run-actions.ts` `runActionFlags`, `task-thread.tsx`'s composer routing,
 * `ask-answer.ts` `askDeliveryMode`), and refused — with nothing changed — in every other one.
 * The refusal is checked here AND again by the route, so a state that moved between the read and
 * the write is still refused by the service.
 *
 * NO NEW STATES. Every action lands the task in a state the cockpit already reaches, through the
 * cockpit's own route, so every exit a state already has — a user message, the autonomous
 * nudge, the monitoring wake timer, cancel, finish, the idle close — still applies to it.
 * Nothing here parks a task, holds a session open or schedules anything.
 *
 * WHERE THE SERVICE COMES FROM. `McpToolContext` does not carry the service's in-process entry
 * yet (#86 shipped it without one, #89 left widening it to later work). This tool reads it from
 * an optional `service` field on the context and answers an honest tool error when it is absent;
 * the service passing its app there is the one wiring step this tool cannot take from its own
 * file.
 *
 * STALE WRITES (#250, N-03). Every action changes the task, so every action requires the
 * `expectedVersion` a `task_read` of it handed out, and sends it to the route, which compares it
 * with the task's current version in the same synchronous stretch as the engine call. A task that
 * moved since is refused with nothing applied (`status: "conflict"`, `error: "stale_version"`,
 * `currentVersion`). The version moves with every event a task records, so a RUNNING task's
 * version moves while its agent works: read it right before acting on a running task.
 */

export const EXECUTION_CONTROL_ACTIONS = [
  'cancel',
  'finish',
  'continue',
  'send_message',
  'answer_question',
  'edit_queued_message',
  'remove_queued_message',
  'cancel_auto_resume',
] as const;
export type ExecutionControlAction = (typeof EXECUTION_CONTROL_ACTIONS)[number];

/** The cockpit's own schedule (`ask-answer.ts`): the idle timer closes the backend before the
 *  RunManager has released the run, so a resume can arrive a few milliseconds early. Only that
 *  exact refusal is retried; every other 409 is an answer. */
export const IDLE_TEARDOWN_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1_000, 1_000, 1_000, 1_000] as const;
const IDLE_TEARDOWN_REFUSAL = 'run is still active';

/** The review panel's Send back prefix (`review-panel.tsx`). */
const REVIEW_FEEDBACK_PREFIX = 'Review feedback:\n';

/** The context this tool reads beyond `McpToolContext`: the running service's in-process entry. */
export type ExecutionControlContext = McpToolContext & { readonly service?: ServiceDispatch };

const answerSchema = z
  .object({
    choices: z
      .array(z.string().min(1).max(60))
      .min(1)
      .max(4)
      .describe('Option labels for this question, exactly as the question lists them. One for a single-select question.'),
  })
  .strict();

type Field = 'text' | 'images' | 'finishAs' | 'questionId' | 'answers' | 'messageId';
const FIELDS: readonly Field[] = ['text', 'images', 'finishAs', 'questionId', 'answers', 'messageId'];

/** Which arguments each action takes. Anything else is refused rather than silently dropped. */
const ACTION_FIELDS: Record<ExecutionControlAction, { required: readonly Field[]; optional: readonly Field[] }> = {
  cancel: { required: [], optional: [] },
  finish: { required: ['finishAs'], optional: [] },
  continue: { required: [], optional: ['text', 'images'] },
  send_message: { required: [], optional: ['text', 'images'] },
  answer_question: { required: ['questionId'], optional: ['answers', 'text'] },
  edit_queued_message: { required: ['messageId'], optional: ['text', 'images'] },
  remove_queued_message: { required: ['messageId'], optional: [] },
  cancel_auto_resume: { required: [], optional: [] },
};

const hasText = (text: string | undefined): text is string => text !== undefined && text.trim().length > 0;

export const executionControlInputSchema = z
  .object({
    action: z.enum(EXECUTION_CONTROL_ACTIONS).describe('What to do with the task.'),
    runId: z.string().min(1).max(128).describe("The task's run id, in the project this connection is bound to."),
    expectedVersion: mcpExpectedVersionSchema.describe(
      'The `version` task_read returned for this task. Echo it verbatim; if the task changed since, nothing is applied.',
    ),
    text: z
      .string()
      .max(100_000)
      .optional()
      .describe('Message, continuation prompt, review feedback, free-form answer, or the new text of a queued message.'),
    images: z
      .array(attachmentInputSchema)
      .max(4)
      .optional()
      .describe('Attachments (base64) for send_message, continue or edit_queued_message — the same four the composer allows.'),
    finishAs: z
      .enum(['close_session', 'accept_review'])
      .optional()
      .describe(
        'Which finish you mean: close_session for a waiting task, accept_review to accept a task at review without a PR. Refused when it does not match the task.',
      ),
    questionId: z.string().min(1).max(128).optional().describe("The pending question's id (its ask requestId)."),
    answers: z
      .array(answerSchema)
      .min(1)
      .max(4)
      .optional()
      .describe('One entry per question, in the order the question card lists them.'),
    messageId: z.string().min(1).max(128).optional().describe("A queued message's id."),
  })
  .strict()
  .superRefine((args, ctx) => {
    const allowed = ACTION_FIELDS[args.action];
    for (const field of FIELDS) {
      const present = args[field] !== undefined;
      if (allowed.required.includes(field) && !present) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${args.action} needs ${field}` });
      }
      if (present && !allowed.required.includes(field) && !allowed.optional.includes(field)) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${field} does not apply to ${args.action}` });
      }
    }
    const bodyActions: readonly ExecutionControlAction[] = ['send_message', 'edit_queued_message'];
    if (bodyActions.includes(args.action) && !hasText(args.text) && !args.images?.length) {
      ctx.addIssue({ code: 'custom', path: ['text'], message: `${args.action} needs text or at least one attachment` });
    }
    if (args.action === 'answer_question' && (args.answers !== undefined) === hasText(args.text)) {
      ctx.addIssue({ code: 'custom', path: ['answers'], message: 'answer_question needs exactly one of answers or text' });
    }
  });
export type ExecutionControlInput = z.output<typeof executionControlInputSchema>;

/** The result, text block and `structuredContent` alike (D-05 § 6.8: the text is authoritative,
 *  and the result is a slim projection rather than the task record). */
export const executionControlResultSchema = z.object({
  action: z.enum(EXECUTION_CONTROL_ACTIONS),
  accepted: z.boolean(),
  /** D-05's closed set, narrowed to what a control can report. `accepted` never means done. */
  status: z.enum(['accepted', 'done', 'cancelled', 'conflict', 'failed']),
  subject: z.object({ type: z.literal('run'), id: z.string() }),
  runStatus: z.string().optional(),
  /** Which seam a message or answer travelled on — the state routing made visible. */
  delivery: z.enum(['live', 'deferred', 'amended', 'continued', 'resumed']).optional(),
  questionId: z.string().optional(),
  messageId: z.string().optional(),
  hadPendingAutoResume: z.boolean().optional(),
  reason: z.string().optional(),
  // A stale-version refusal (#250) carries D-06 § 4.4's payload keys verbatim beside the above.
  ...staleVersionRejectionSchema.omit({ status: true }).partial().shape,
  origin: z.literal(MCP_ORIGIN),
});
export type ExecutionControlResult = z.infer<typeof executionControlResultSchema>;

// ---- the routes the shared adapter does not name yet -------------------------------------------

const IN_PROCESS_BASE = 'http://127.0.0.1';
const IN_PROCESS_HOST = '127.0.0.1';

/** The same in-process client the adapter builds (`service-adapter.ts`): loopback host, no Origin. */
const scopedApi = (service: ServiceDispatch) =>
  hc<AppType>(IN_PROCESS_BASE, {
    fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set('host', IN_PROCESS_HOST);
      headers.delete('origin');
      const url = input instanceof Request ? input.url : String(input);
      return service.request(url, { ...init, headers });
    },
  }).api.v1.p[':projectId'];

type Answer<T> = { ok: true; status: number; value: T } | { ok: false; status: number; error: string; body?: unknown };

/** Map a service answer. A success without a JSON body is an error, never an empty value. */
async function settle<T>(pending: Promise<Response>, success: readonly number[]): Promise<Answer<T>> {
  const res = await pending;
  const body: unknown = await res.json().catch(() => undefined);
  if (success.includes(res.status)) {
    if (body === undefined) return { ok: false, status: 502, error: `service answered ${res.status} without a body` };
    return { ok: true, status: res.status, value: body as T };
  }
  const error =
    body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `service answered ${res.status}`;
  return { ok: false, status: res.status, error, body };
}

/** The adapter's rule for a path parameter: a valid id that is not a dot segment. */
const validPathId = (id: string): boolean => id !== '.' && id !== '..' && runIdParamSchema.safeParse({ id }).success;

// ---- the cockpit's state rules, ported ----------------------------------------------------------

type Run = GetRunValue;

/** `run-actions.ts` `isRunActive`: the engine still owns the run. */
const isActive = (run: Run): boolean => run.status === 'running' || run.status === 'queued' || run.status === 'waiting';
/** `task-thread.tsx`: the composer delivers into a live session while running or waiting. */
const sessionOpen = (run: Run): boolean => run.status === 'running' || run.status === 'waiting';
/** `run-actions.ts` `lastSessionId` — Continue needs a recorded agent session. */
const hasSession = (run: Run): boolean => run.steps.some((step) => step.sessionId);

/** `ask-answer.ts` `askDeliveryMode`. */
export function askDeliveryMode(run: Pick<Run, 'status' | 'steps'>): 'live' | 'resume' | 'unavailable' {
  if (isActive(run as Run)) return 'live';
  return hasSession(run as Run) ? 'resume' : 'unavailable';
}

const askQuestionSchema = z
  .object({
    header: z.string(),
    options: z.array(z.object({ label: z.string() }).passthrough()),
    multiSelect: z.boolean().optional(),
  })
  .passthrough();
type AskQuestion = z.infer<typeof askQuestionSchema>;

export interface PendingQuestion {
  requestId: string;
  questions: AskQuestion[];
}

/**
 * The one question an answer can reach: the newest `ask.requested` with no `user-message` after
 * it — the cockpit's reducer (`thread-state.ts`), which resolves whichever ask is pending with
 * the next user message. An older ask that a newer one superseded is NOT pending, however
 * unanswered it looks: a message sent for it would be read as the answer to the newer one.
 * `events` may be in any order; a malformed ask is skipped, exactly as the reducer skips it.
 */
export function pendingQuestionIn(events: ReadonlyArray<{ seq: number; type: string } & Record<string, unknown>>):
  | PendingQuestion
  | null
  | undefined {
  const newestFirst = [...events].sort((a, b) => b.seq - a.seq);
  for (const event of newestFirst) {
    if (event.type === 'user-message') return null;
    if (event.type !== 'ask.requested' || typeof event.requestId !== 'string' || !Array.isArray(event.questions)) continue;
    const questions = event.questions.flatMap((q) => {
      const parsed = askQuestionSchema.safeParse(q);
      return parsed.success ? [parsed.data] : [];
    });
    if (questions.length > 0) return { requestId: event.requestId, questions };
  }
  // Neither found in these events: the caller must read older ones before concluding "none".
  return undefined;
}

/** The ask card's answer text (`ask-card.tsx` `formatAnswer`), one line per question. */
export function formatAnswers(
  questions: readonly AskQuestion[],
  answers: ReadonlyArray<{ choices: readonly string[] }>,
): { ok: true; text: string } | { ok: false; error: string } {
  if (answers.length !== questions.length) {
    return { ok: false, error: `answer every question: this one has ${questions.length}, the call gave ${answers.length}` };
  }
  const lines: string[] = [];
  for (const [index, question] of questions.entries()) {
    const choices = answers[index]!.choices;
    const labels = question.options.map((option) => option.label);
    const unknown = choices.find((choice) => !labels.includes(choice));
    if (unknown !== undefined) {
      return { ok: false, error: `"${unknown}" is not an option of "${question.header}" (${labels.join(', ')})` };
    }
    if (new Set(choices).size !== choices.length) return { ok: false, error: `"${question.header}" repeats a choice` };
    if (question.multiSelect !== true && choices.length !== 1) {
      return { ok: false, error: `"${question.header}" takes exactly one choice` };
    }
    lines.push(`${question.header}: ${choices.join(', ')}`);
  }
  return { ok: true, text: lines.join('\n') };
}

// ---- the tool ---------------------------------------------------------------------------------

interface Services {
  adapter: McpServiceAdapter;
  api: ReturnType<typeof scopedApi>;
  projectId: string;
  wait: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function result(args: ExecutionControlInput, fields: Omit<ExecutionControlResult, 'action' | 'subject' | 'origin'>): McpToolResult {
  const value: ExecutionControlResult = {
    action: args.action,
    subject: { type: 'run', id: args.runId },
    ...fields,
    origin: MCP_ORIGIN,
  };
  const structured = value as unknown as Record<string, unknown>;
  const text = JSON.stringify(value);
  return value.status === 'failed' ? errorResult(text, structured) : textResult(text, structured);
}

/** A state that does not allow the action: an ordinary result (D-05: a business conflict is not
 *  `isError`), and nothing was changed. */
const conflict = (args: ExecutionControlInput, run: Run, reason: string) =>
  result(args, { accepted: false, status: 'conflict', runStatus: run.status, reason });

/** A bad target or a service failure: a tool error the model can correct. */
const failed = (args: ExecutionControlInput, reason: string) => result(args, { accepted: false, status: 'failed', reason });

/** The task changed after the leader read it (#250): refused, nothing applied, never retried here. */
function staleConflict(args: ExecutionControlInput, run: Run, stale: StaleVersionRejection): McpToolResult {
  const { status: _conflict, ...payload } = stale;
  return result(args, { accepted: false, status: 'conflict', runStatus: run.status, reason: stale.guidance, ...payload });
}

/** The service refused: a stale version, a state conflict (409), or a failure. */
const refused = (args: ExecutionControlInput, run: Run, answer: { status: number; error: string; body?: unknown }) => {
  const stale = staleRejectionIn(answer.body);
  if (stale) return staleConflict(args, run, stale);
  return answer.status === 409 ? conflict(args, run, answer.error) : failed(args, answer.error);
};

async function currentStatus(s: Services, runId: string, fallback: string): Promise<string> {
  const read = await s.adapter.getRun(runId);
  return read.ok ? read.value.status : fallback;
}

async function pendingQuestion(s: Services, runId: string): Promise<Answer<PendingQuestion | null>> {
  let cursor: string | undefined;
  // Newest page first, then older ones, until a user message or an ask is found or history ends.
  for (;;) {
    const page = await settle<RunHistoryPage>(
      s.api.runs[':id'].history.$get({ param: { projectId: s.projectId, id: runId }, query: cursor ? { cursor } : {} }),
      [200],
    );
    if (!page.ok) return page;
    const found = pendingQuestionIn(page.value.events);
    if (found !== undefined) return { ok: true, status: 200, value: found };
    if (!page.value.hasOlder || !page.value.olderCursor) return { ok: true, status: 200, value: null };
    cursor = page.value.olderCursor;
  }
}

async function postMessage(
  s: Services,
  runId: string,
  text: string | undefined,
  images: ExecutionControlInput['images'],
  expectedVersion: string,
) {
  return settle<{ delivered: true } | { queued: true; message: { id: string } } | { deferred: true }>(
    s.api.runs[':id'].messages.$post({
      param: { projectId: s.projectId, id: runId },
      json: { text: text ?? '', images: images ?? [], expectedVersion },
    }),
    [200],
  );
}

async function postContinue(
  s: Services,
  runId: string,
  text: string | undefined,
  images: ExecutionControlInput['images'],
  expectedVersion: string,
) {
  return settle<{ continued: true }>(
    s.api.runs[':id'].continue.$post({
      param: { projectId: s.projectId, id: runId },
      json: { ...(text !== undefined ? { text } : {}), ...(images?.length ? { images } : {}), expectedVersion },
    }),
    [200],
  );
}

/** `ask-answer.ts` `resumeAfterIdleTeardown`: retry only the idle-teardown 409, on its schedule. A
 *  stale-version refusal is never retried: it is not the teardown, it is the answer. */
async function continueAfterIdleTeardown(s: Services, runId: string, text: string, expectedVersion: string) {
  for (let retries = 0; ; retries += 1) {
    const answer = await postContinue(s, runId, text, undefined, expectedVersion);
    const delay = IDLE_TEARDOWN_RETRY_DELAYS_MS[retries];
    if (answer.ok || answer.status !== 409 || answer.error !== IDLE_TEARDOWN_REFUSAL || delay === undefined) return answer;
    await s.wait(delay);
  }
}

const messageDelivery = (value: object): 'live' | 'amended' | 'deferred' =>
  'queued' in value ? 'amended' : 'deferred' in value ? 'deferred' : 'live';

async function control(args: ExecutionControlInput, s: Services): Promise<McpToolResult> {
  // The target is read first, through the adapter: an id outside the bound project is a 404 and
  // a malformed one is refused before anything is dispatched.
  const read = await s.adapter.getRun(args.runId);
  if (!read.ok) return failed(args, read.error);
  const run = read.value;
  const id = run.id;
  // Sent with every effect below; the route compares it with the task's current version (#250).
  const version = args.expectedVersion;
  const guard = { expectedVersion: version };

  switch (args.action) {
    case 'cancel': {
      if (!isActive(run)) return conflict(args, run, `cancel is offered only while the task is active; it is ${run.status}`);
      const answer = await s.adapter.cancelRun(id, version);
      if (!answer.ok) return refused(args, run, answer);
      if (!answer.value.cancelled) return conflict(args, run, 'the task was no longer active, so nothing was cancelled');
      const after = await currentStatus(s, id, run.status);
      // A queued task is dropped at once; an active one stops asynchronously. Its worktree stays.
      return result(args, { accepted: true, status: after === 'cancelled' ? 'cancelled' : 'accepted', runStatus: after });
    }

    case 'finish': {
      const meaning = run.status === 'waiting' ? 'close_session' : run.status === 'review' ? 'accept_review' : undefined;
      if (!meaning) {
        return conflict(
          args,
          run,
          `finish is offered only for a waiting task (close the session) or a task at review (accept without a PR); it is ${run.status}`,
        );
      }
      if (args.finishAs !== meaning) {
        return conflict(args, run, `the task is ${run.status}, so finish means ${meaning} here, not ${args.finishAs}; nothing was changed`);
      }
      const answer = await settle<{ finished: true }>(
        s.api.runs[':id'].finish.$post({ param: { projectId: s.projectId, id }, json: guard }),
        [200],
      );
      if (!answer.ok) return refused(args, run, answer);
      const after = await currentStatus(s, id, run.status);
      return result(args, { accepted: true, status: meaning === 'accept_review' ? 'done' : 'accepted', runStatus: after });
    }

    case 'continue': {
      if (isActive(run)) return conflict(args, run, `the task is ${run.status}, not closed — send a message instead`);
      if (!hasSession(run)) return conflict(args, run, 'no agent session to resume');
      let text = args.text;
      if (run.status === 'review') {
        // Send back (`review-panel.tsx`): feedback is required and rides with its prefix.
        if (!hasText(text)) return conflict(args, run, 'sending a task at review back needs feedback: write what to change first');
        text = `${REVIEW_FEEDBACK_PREFIX}${text}`;
      }
      const answer = await postContinue(s, id, text, args.images, version);
      if (!answer.ok) return refused(args, run, answer);
      const after = await currentStatus(s, id, run.status);
      return result(args, { accepted: true, status: 'accepted', runStatus: after, delivery: 'continued' });
    }

    case 'send_message': {
      // The composer's routing (`task-thread.tsx`): open session → send, queued → amend,
      // closed with a session → continue with the text, anything else → disabled.
      if (sessionOpen(run) || run.status === 'queued') {
        const answer = await postMessage(s, id, args.text, args.images, version);
        if (!answer.ok) return refused(args, run, answer);
        const delivery = messageDelivery(answer.value);
        const after = await currentStatus(s, id, run.status);
        return result(args, {
          accepted: true,
          status: delivery === 'amended' ? 'done' : 'accepted',
          runStatus: after,
          delivery,
          ...('queued' in answer.value ? { messageId: answer.value.message.id } : {}),
        });
      }
      if (!hasSession(run)) return conflict(args, run, 'Session closed — no session to resume.');
      const answer = await postContinue(s, id, args.text, args.images, version);
      if (!answer.ok) return refused(args, run, answer);
      const after = await currentStatus(s, id, run.status);
      return result(args, { accepted: true, status: 'accepted', runStatus: after, delivery: 'continued' });
    }

    case 'answer_question': {
      const pending = await pendingQuestion(s, id);
      if (!pending.ok) return refused(args, run, pending);
      if (!pending.value) return conflict(args, run, 'this task has no pending question; nothing was sent');
      // THE TARGETING CHECK: an answer is delivered as the task's next user message, which the
      // task reads as the answer to ITS pending question. Any other question id — a superseded
      // ask, or another task's — would have its answer land on the wrong question.
      if (pending.value.requestId !== args.questionId) {
        return conflict(
          args,
          run,
          `that question is not this task's pending question (${pending.value.requestId}); nothing was sent`,
        );
      }
      let text: string;
      if (args.answers) {
        const formatted = formatAnswers(pending.value.questions, args.answers);
        if (!formatted.ok) return failed(args, formatted.error);
        text = formatted.text;
      } else {
        text = args.text!;
      }
      const mode = askDeliveryMode(run);
      if (mode === 'unavailable') {
        return conflict(args, run, 'This session has ended and no agent session was recorded, so the answer cannot be delivered.');
      }
      const questionId = pending.value.requestId;
      if (mode === 'live') {
        const answer = await postMessage(s, id, text, undefined, version);
        if (answer.ok) {
          const after = await currentStatus(s, id, run.status);
          return result(args, { accepted: true, status: 'accepted', runStatus: after, delivery: messageDelivery(answer.value), questionId });
        }
        // The record said live but the session had just closed: resume rather than drop it. A
        // stale version is not that case — the task moved, and the leader must read it again.
        if (answer.status !== 409 || !hasSession(run) || staleRejectionIn(answer.body)) return refused(args, run, answer);
      }
      const answer = await continueAfterIdleTeardown(s, id, text, version);
      if (!answer.ok) return refused(args, run, answer);
      const after = await currentStatus(s, id, run.status);
      return result(args, { accepted: true, status: 'accepted', runStatus: after, delivery: 'resumed', questionId });
    }

    case 'edit_queued_message':
    case 'remove_queued_message': {
      const messageId = args.messageId!;
      // A fixed message: a refusal never echoes what the caller sent (#88, N-01).
      if (!validPathId(messageId)) return failed(args, 'not a message id');
      if (run.status !== 'queued') {
        return conflict(args, run, `queued messages can be changed only while the task is queued; it is ${run.status}`);
      }
      const param = { projectId: s.projectId, id, msgId: messageId };
      const answer =
        args.action === 'edit_queued_message'
          ? await settle<unknown>(
              s.api.runs[':id']['queued-messages'][':msgId'].$patch({
                param,
                json: {
                  ...(args.text !== undefined ? { text: args.text } : {}),
                  ...(args.images ? { images: args.images } : {}),
                  ...guard,
                },
              }),
              [200],
            )
          : await settle<unknown>(s.api.runs[':id']['queued-messages'][':msgId'].$delete({ param, json: guard }), [200]);
      if (!answer.ok) return refused(args, run, answer);
      return result(args, { accepted: true, status: 'done', runStatus: run.status, messageId });
    }

    case 'cancel_auto_resume': {
      const answer = await settle<{ cancelled: true }>(
        s.api.runs[':id']['auto-resume'].$delete({ param: { projectId: s.projectId, id }, json: guard }),
        [200],
      );
      if (!answer.ok) return refused(args, run, answer);
      return result(args, {
        accepted: true,
        status: 'done',
        runStatus: run.status,
        hadPendingAutoResume: run.autoResumeAt !== undefined,
      });
    }
  }
}

/** Build the tool over an injectable wait, so the idle-teardown schedule is testable. */
export function createExecutionControlTool(wait: (ms: number) => Promise<void> = sleep) {
  return defineTool({
    name: 'execution_control',
    title: 'Control a task and talk to its session',
    description: [
      "Control one of this project's own tasks, as the cockpit's buttons and composer do. Each action is allowed only in the states the cockpit allows it and is otherwise refused with nothing changed (status \"conflict\" and a reason).",
      'cancel — stop a queued, running or waiting task; it ends cancelled and keeps its worktree.',
      'finish — finishAs "close_session" closes a waiting task\'s session; finishAs "accept_review" accepts a task at review without a PR.',
      'continue — reopen a closed task\'s last session, with optional text; for a task at review, text is required and is sent back as review feedback.',
      'send_message — routed by state: an open session receives it, a queued task gets it folded into its prompt, a closed task with a session is continued with it; otherwise refused.',
      'answer_question — answer the task\'s pending question by its questionId, with the option labels (answers) or free text; only the pending question can be answered, and a closed session is reopened to deliver it.',
      'edit_queued_message / remove_queued_message — change a message stacked on a queued task.',
      'cancel_auto_resume — stop a scheduled automatic resume after a usage limit.',
      'Every action needs expectedVersion: the `version` task_read (view task) returned for this task. If the task changed since you read it, nothing is applied and the answer is status "conflict" with error "stale_version": read it again and decide again. A running task\'s version moves as its agent works, so read it right before acting.',
      'Targets tasks only by run id in the bound project; there is no process-level control. Plan approval and decisions outside the approved goal stay with the human.',
    ].join('\n'),
    inputSchema: executionControlInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async call(args, ctx) {
      const service = (ctx as ExecutionControlContext).service;
      if (!service) {
        return errorResult(
          'execution_control is not connected to this cockpit\'s task services yet; nothing was changed. Use the cockpit for this action.',
        );
      }
      const projectId = ctx.project.id;
      return control(args, { adapter: new McpServiceAdapter({ projectId, service }), api: scopedApi(service), projectId, wait });
    },
  });
}

export const executionControlTool = createExecutionControlTool();
