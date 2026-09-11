import { AsyncLocalStorage } from 'node:async_hooks';
import {
  MCP_EVENT_KIND_CATEGORY,
  mcpJournalOperationIdSchema,
  providerStatusSchema,
  type McpEventKind,
  type McpEventSubjectType,
  type McpJournalAppendInput,
  type McpJournalOrigin,
  type McpJournalRow,
  type ProviderStatus,
} from '@qodeca/xezar-contract';

import type { RunEvent, RunRecord, RunStore } from '../runs/store.ts';
import { runVersion } from './stale-write.ts';

/**
 * The significant-event catalog E-01–E-06 (#104): what enters the project journal (#103), and —
 * equally binding — what never does. Kinds and categories are `packages/contract/src/
 * mcp-event-catalog.ts`; the journal is `./event-journal.ts`.
 *
 * WHERE THE ROWS COME FROM. N-02: nothing here is an MCP-only path. The catalog LISTENS to the
 * shared services the cockpit already drives — the `RunStore` bus (`'run'` snapshots and `'event'`
 * lines, the same two the SSE streams relay) and the workspace bus (`provider-status`) — so a
 * change caused through the cockpit and one caused through MCP reach the same derivation and
 * produce the same row. The two changes that have no in-process signal today (a configuration
 * write and a workflow write, E-05) are reported by their writer through `configChanged` /
 * `workflowChanged` / `agentConfigChanged`.
 *
 * WHAT ENTERS, derived rather than forwarded (D-05 § 5.1 — a terminal status is not an event type):
 *  - E-01  a run status transition to `done` / `failed` / `cancelled`, or to `waiting` WITHOUT a
 *          structured question (`task.blocked` — the run cannot go on without input);
 *  - E-02  a transition to `waiting` that follows an `ask.requested` line (`question.asked`), and a
 *          human `user-message` to a run that was `waiting` (`question.answered`);
 *  - E-03  a CHECK step settling `done`/`failed` (a quality gate), and a transition to `review` —
 *          F-11 keeps the optional review a different kind from a mandatory gate;
 *  - E-04  a HUMAN edit of a queued run's prompt (`goal.changed`), a human message to a run that
 *          was not waiting (`instruction.added`), and a human add/edit/remove of a queued message;
 *  - E-05  the writer-reported configuration, workflow and agent-config changes, minus the keys
 *          that only change presentation (`liveTitleUpdates`, `namerModel` only name tasks);
 *  - E-06  a provider's availability (`connected` and not disabled) flipping.
 *
 * WHAT NEVER ENTERS. Every other `'event'` type — `item.*`, `tool-call`, `tool-result`, `text`,
 * `note` and `check-output` (log lines), `token-usage`, `cost`, `usage.updated` (token counters),
 * `lifecycle`, `step-*`, `turn.*`, `session.*`, and every ephemeral live frame. Every other record
 * change — token/cost/RSS counters, `diffStat`, titles and `titleSummary`, `seenAt`, pin, archive,
 * the `monitoring` activity, `queued`→`running`. Every other workspace event — `checkout-progress`,
 * `project-*`, `automation-change`. The SSE `ping` keepalive is never on a bus at all. None of
 * these start a model turn: no heartbeat, transport retry, acknowledgement or deduplication does.
 * There is no coalescing either (D-05 § 8 N3): one qualifying change is exactly one row.
 *
 * ORIGIN (D-05 § 6.3: `human | leader | system`). Derived from the door a change came through,
 * never from anything a client says. The MCP door marks its dispatch with `withEventOrigin`
 * (`leader` + the operation id); a change made synchronously inside that call inherits it through
 * `AsyncLocalStorage`. A change that lands LATER — cancelling a running task interrupts its agent,
 * and the `cancelled` status is written when the process exits — cannot inherit it, so the call
 * also leaves an INTENT on the run it names, consumed by that run's next status transition. With
 * neither, each derivation has its own honest default: an engine transition is `system`; a
 * cancellation, a message and a queued-prompt edit only ever start at a person's request, so they
 * are `human` (the cockpit is the only other door that issues them). E-04 is a HUMAN change by
 * definition: a leader's own edit writes no E-04 row, and neither does a leader's answer to a
 * question — while a cancellation, whoever issued it, writes the SAME E-01 row, distinguishable
 * only by `origin` and `causedBy`, which is what the F-13 echo guard needs.
 *
 * Never throws into the service that emitted the change: the store emits from inside its own
 * write, and a journal problem must not fail a task. A row that cannot be written is warned about
 * once and dropped — the journal keeps its sequence gapless by not spending a number (#103).
 *
 * NOT READ HERE: nothing private to `RunManager`, in particular no `ActiveRun` field — `ActiveRun`
 * is built in both `execute` and `runContinuation`, and this module depends on neither. A Continue
 * and a restart recovery reach the same store calls, and therefore the same rows, as a first run.
 */

/** Who caused a change, as the door it came through knows it. */
export interface EventOriginContext {
  readonly origin: McpJournalOrigin;
  /** The leader operation id (D-06 § 5.2) — required for `leader`, `null` otherwise. */
  readonly causedBy: string | null;
  /** The run the operation targets, when it has one: the intent a later transition consumes. */
  readonly runId?: string;
}

/**
 * The origin of the call in flight, and whether that call is still in flight. `AsyncLocalStorage`
 * alone would also hand the context to every async chain the call merely STARTED — a task started
 * through MCP runs for minutes on the promise chain its start created, and its completion would read
 * as the leader's own change, which the echo guard then hides from the leader (#243). `live` ends
 * that at the call's own settlement, so only a change made within the call inherits its origin.
 */
const originScope = new AsyncLocalStorage<{ readonly context: EventOriginContext; live: boolean }>();

/** The origin of the change being made right now, if an origin-marked call is still making it. */
function currentOrigin(): EventOriginContext | undefined {
  const scope = originScope.getStore();
  return scope?.live ? scope.context : undefined;
}

/**
 * Intents left by an origin-marked call for a run whose effect lands after the call returned. One
 * per run; consumed by the run's next status transition, whether or not that transition writes a
 * row, so an intent never outlives the change it was for by more than one transition.
 */
const pendingIntents = new Map<string, EventOriginContext>();

/**
 * Run `fn` as a change caused by `context`. The MCP door wraps each dispatched operation in this;
 * nothing else needs to. Throws only on a caller bug: a `leader` context without a valid
 * operation id would defeat the echo guard it exists for.
 */
export function withEventOrigin<T>(context: EventOriginContext, fn: () => T): T {
  if (context.origin === 'leader' && !mcpJournalOperationIdSchema.safeParse(context.causedBy).success) {
    throw new Error('a leader change must name the operation that caused it');
  }
  if (context.origin !== 'leader' && context.causedBy !== null) {
    throw new Error('only a leader change carries an operation id');
  }
  if (context.runId !== undefined) pendingIntents.set(context.runId, context);
  const scope = { context, live: true };
  const end = (): void => {
    scope.live = false;
  };
  let result: T;
  try {
    result = originScope.run(scope, fn);
  } catch (err) {
    end();
    throw err;
  }
  const pending = result as { then?: unknown };
  // Observed, never rethrown from here: the caller still receives `result` itself, rejection and all.
  if (pending !== null && typeof pending === 'object' && typeof pending.then === 'function') {
    (result as PromiseLike<unknown>).then(end, end);
  } else {
    end();
  }
  return result;
}

/** The journal as the catalog writes it — `EventJournal` satisfies it. */
export interface CatalogJournal {
  append(input: McpJournalAppendInput): McpJournalRow | undefined;
}

/** The workspace bus as the catalog reads it — `WorkspaceEventBus` satisfies it. */
export interface WorkspaceEventSource {
  on(listener: (event: string, data: unknown) => void): () => void;
}

export interface EventCatalogOptions {
  journal: CatalogJournal;
  /** The project's store. Runs already in it are the baseline: attaching writes no row. */
  store: RunStore;
  /** Host-wide `provider-status` (E-06). Absent: no executor rows, nothing else changes. */
  workspaceEvents?: WorkspaceEventSource;
  /** Provider rows as they are at attach time (`ProviderAuth.status()`), the E-06 baseline. A
   *  provider seen for the first time without one counts as a change. */
  providerBaseline?: readonly ProviderStatus[];
  /** Where the one warning about an unwritable row goes. */
  warn?: (message: string) => void;
}

/** Configuration keys whose only effect is how tasks are NAMED — presentation, not execution. */
const PRESENTATION_CONFIG_KEYS: ReadonlySet<string> = new Set(['liveTitleUpdates', 'namerModel']);

const SUBJECT_ID_MAX = 256;

/** What the catalog remembers of a run between two snapshots — the store mutates its records in
 *  place, so the previous state has to be copied out. */
interface RunMemory {
  status: RunRecord['status'];
  task: string;
  queued: ReadonlyMap<string, string>;
  steps: ReadonlyMap<string, RunRecord['steps'][number]['status']>;
  /** Questions in an `ask.requested` line not yet matched by the `waiting` transition. */
  askedQuestions?: number;
}

function remember(run: RunRecord, askedQuestions?: number): RunMemory {
  return {
    status: run.status,
    task: run.task,
    queued: new Map((run.queuedMessages ?? []).map((message) => [message.id, message.text])),
    steps: new Map(run.steps.map((step) => [step.id, step.status])),
    ...(askedQuestions === undefined ? {} : { askedQuestions }),
  };
}

export class EventCatalog {
  readonly #journal: CatalogJournal;
  readonly #store: RunStore;
  readonly #warn: (message: string) => void;
  readonly #runs = new Map<string, RunMemory>();
  readonly #executors = new Map<string, boolean>();
  readonly #unsubscribe: Array<() => void> = [];
  #warned = false;

  private constructor(options: EventCatalogOptions) {
    this.#journal = options.journal;
    this.#store = options.store;
    this.#warn = options.warn ?? ((message) => console.warn(message));
  }

  /** Start deriving rows from the project's services. Returns the catalog; `detach` stops it. */
  static attach(options: EventCatalogOptions): EventCatalog {
    const catalog = new EventCatalog(options);
    for (const run of options.store.listRuns()) catalog.#runs.set(run.id, remember(run));
    for (const row of options.providerBaseline ?? []) catalog.#executors.set(executorId(row), isAvailable(row));

    const onRun = (run: RunRecord) => catalog.#guard(() => catalog.#onRun(run));
    const onEvent = (payload: { runId: string; event: RunEvent }) =>
      catalog.#guard(() => catalog.#onEvent(payload.runId, payload.event));
    const onDeleted = (runId: string) => {
      catalog.#runs.delete(runId);
      pendingIntents.delete(runId);
    };
    options.store.on('run', onRun);
    options.store.on('event', onEvent);
    options.store.on('deleted', onDeleted);
    catalog.#unsubscribe.push(
      () => options.store.off('run', onRun),
      () => options.store.off('event', onEvent),
      () => options.store.off('deleted', onDeleted),
    );
    if (options.workspaceEvents) {
      catalog.#unsubscribe.push(
        options.workspaceEvents.on((event, data) => {
          if (event === 'provider-status') catalog.#guard(() => catalog.#onProviderStatus(data));
        }),
      );
    }
    return catalog;
  }

  /** Stop listening. Every subscription `attach` made is released — none outlives the catalog. */
  detach(): void {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#runs.clear();
    this.#executors.clear();
  }

  /**
   * E-05: the project configuration was written (`PUT /config`). `keys` are the fields the write
   * set or cleared — names only, never values. A write that touched nothing but presentation
   * writes no row.
   */
  configChanged(input: { keys: readonly string[]; version?: string | null }): McpJournalRow | undefined {
    const keys = [...new Set(input.keys)].filter((key) => !PRESENTATION_CONFIG_KEYS.has(key)).sort();
    if (keys.length === 0) return undefined;
    return this.#guard(() =>
      this.#append('config.changed', { type: 'config', id: 'project', version: input.version ?? null }, this.#originOr('human'),
        `project configuration changed: ${keys.join(', ')}`),
    );
  }

  /** E-05: a project workflow was saved or deleted (`POST /workflows`, `DELETE /workflows/:name`). */
  workflowChanged(input: { name: string; change: 'saved' | 'deleted'; version?: string | null }): McpJournalRow | undefined {
    const kind = input.change === 'saved' ? 'workflow.saved' : 'workflow.deleted';
    return this.#guard(() =>
      this.#append(kind, { type: 'workflow', id: input.name.slice(0, SUBJECT_ID_MAX), version: input.version ?? null },
        this.#originOr('human'), `workflow "${clip(input.name, 120)}" ${input.change}`),
    );
  }

  /** E-05: an agent configuration file was written (`PUT /agent-config/:id`), by catalog id. */
  agentConfigChanged(input: { id: string; version?: string | null }): McpJournalRow | undefined {
    return this.#guard(() =>
      this.#append('agent-config.changed', { type: 'agent-config', id: input.id.slice(0, SUBJECT_ID_MAX), version: input.version ?? null },
        this.#originOr('human'), `agent configuration ${clip(input.id, 120)} changed`),
    );
  }

  // ---- runs -----------------------------------------------------------------------------------

  #onRun(run: RunRecord): void {
    const before = this.#runs.get(run.id);
    // A run seen for the first time — created, or first touched after attach — is the baseline.
    if (!before) {
      this.#runs.set(run.id, remember(run));
      return;
    }
    const statusChanged = before.status !== run.status;
    // An unmatched question survives only until the run's status next moves.
    this.#runs.set(run.id, remember(run, statusChanged ? undefined : before.askedQuestions));

    // E-03 — a quality gate settled. Before the status row, which is the order it happened in.
    for (const step of run.steps) {
      if (step.kind !== 'check' || before.steps.get(step.id) === step.status) continue;
      if (step.status === 'done' || step.status === 'failed') {
        const passed = step.status === 'done';
        this.#appendRun(passed ? 'gate.passed' : 'gate.failed', run.id, this.#originOr('system'),
          `quality gate ${clip(step.id, 80)} ${passed ? 'passed' : 'failed'}`);
      }
    }

    // E-04 — the prompt and its stack change only through the queued-prompt edits (#472).
    if (before.task !== run.task) this.#humanChange('goal.changed', run.id, 'the queued task prompt was edited');
    const queued = remember(run).queued;
    for (const [id, text] of queued) {
      if (!before.queued.has(id)) this.#humanChange('instruction.queued', run.id, 'a message was queued onto the task');
      else if (before.queued.get(id) !== text) this.#humanChange('instruction.edited', run.id, 'a queued message was edited');
    }
    for (const id of before.queued.keys()) {
      if (!queued.has(id)) this.#humanChange('instruction.removed', run.id, 'a queued message was removed');
    }

    if (statusChanged) this.#onStatus(run, before);
  }

  #onStatus(run: RunRecord, before: RunMemory): void {
    const origin = this.#transitionOrigin(run.id, run.status === 'cancelled' ? 'human' : 'system');
    switch (run.status) {
      case 'done':
        this.#appendRun('task.done', run.id, origin, 'task finished: done');
        return;
      case 'failed': {
        const step = run.steps.find((candidate) => candidate.status === 'failed');
        this.#appendRun('task.failed', run.id, origin, step ? `task finished: failed at step ${clip(step.id, 80)}` : 'task finished: failed');
        return;
      }
      case 'cancelled':
        this.#appendRun('task.cancelled', run.id, origin, 'task finished: cancelled');
        return;
      case 'review':
        this.#appendRun('result.ready', run.id, origin, 'result ready for assessment (review)');
        return;
      case 'waiting':
        if (before.askedQuestions !== undefined) {
          this.#appendRun('question.asked', run.id, origin, questionSummary(before.askedQuestions));
        } else {
          this.#appendRun('task.blocked', run.id, origin, 'task is waiting for input');
        }
        return;
      default:
        // `queued` and `running` are the engine doing its job, not something to reason about.
        return;
    }
  }

  #onEvent(runId: string, event: RunEvent): void {
    const memory = this.#runs.get(runId);
    if (!memory) return;
    if (event.type === 'ask.requested') {
      const count = Array.isArray(event.questions) ? event.questions.length : 1;
      // The engine raises the question and THEN parks the run; a backend that parks first gets
      // its row here instead. Either way: one question, one row.
      if (memory.status === 'waiting') {
        this.#appendRun('question.asked', runId, this.#originOr('system'), questionSummary(count));
      } else {
        memory.askedQuestions = count;
      }
      return;
    }
    if (event.type === 'user-message') {
      const origin = this.#originOr('human');
      // A leader's own answer or instruction is its operation, not a human change (E-02/E-04).
      if (origin.origin !== 'human') return;
      if (memory.status === 'waiting') this.#appendRun('question.answered', runId, origin, 'a human answered the waiting task');
      else this.#appendRun('instruction.added', runId, origin, 'a human sent the task a new instruction');
    }
    // Everything else is transcript: log lines, token counters, tool traffic. Never a row.
  }

  #humanChange(kind: McpEventKind, runId: string, summary: string): void {
    const origin = this.#originOr('human');
    if (origin.origin === 'human') this.#appendRun(kind, runId, origin, summary);
  }

  /** The origin of a status transition: the current call, else an intent left for this run, else
   *  the default. Consumes the intent either way — it was for this transition. */
  #transitionOrigin(runId: string, fallback: McpJournalOrigin): EventOriginContext {
    const current = currentOrigin();
    const intent = pendingIntents.get(runId);
    pendingIntents.delete(runId);
    return current ?? intent ?? { origin: fallback, causedBy: null };
  }

  #originOr(fallback: McpJournalOrigin): EventOriginContext {
    return currentOrigin() ?? { origin: fallback, causedBy: null };
  }

  #appendRun(kind: McpEventKind, runId: string, origin: EventOriginContext, summary: string): void {
    this.#append(kind, { type: 'run', id: runId, version: runVersion(this.#store, runId) ?? null }, origin, summary);
  }

  // ---- executors --------------------------------------------------------------------------------

  #onProviderStatus(data: unknown): void {
    const parsed = providerStatusSchema.safeParse(data);
    if (!parsed.success) return;
    const id = executorId(parsed.data);
    const available = isAvailable(parsed.data);
    if (this.#executors.get(id) === available) return;
    this.#executors.set(id, available);
    this.#append(available ? 'executor.available' : 'executor.unavailable', { type: 'executor', id, version: null },
      this.#originOr('system'),
      available ? `executor ${id} is available` : `executor ${id} is unavailable (${describeUnavailable(parsed.data)})`);
  }

  // ---- writing ------------------------------------------------------------------------------------

  #append(
    kind: McpEventKind,
    subject: { type: McpEventSubjectType; id: string; version: string | null },
    origin: EventOriginContext,
    summary: string,
  ): McpJournalRow | undefined {
    return this.#journal.append({
      category: MCP_EVENT_KIND_CATEGORY[kind],
      kind,
      subject,
      origin: origin.origin,
      causedBy: origin.causedBy,
      summary,
    });
  }

  #guard<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      if (!this.#warned) {
        this.#warned = true;
        const message = err instanceof Error ? err.message : String(err);
        this.#warn(`[xez] MCP event catalog could not record an event (${message}) — continuing without it`);
      }
      return undefined;
    }
  }
}

function executorId(row: ProviderStatus): string {
  return row.profileId ? `${row.provider}:${row.profileId}` : row.provider;
}

/** An executor can take work when it is connected and not switched off in Settings. */
function isAvailable(row: ProviderStatus): boolean {
  return row.status === 'connected' && row.enabled !== false;
}

/** The coarse state only — never `hint`, which is prose from the CLI. */
function describeUnavailable(row: ProviderStatus): string {
  if (row.enabled === false) return 'disabled';
  return row.status;
}

function questionSummary(count: number): string {
  return count === 1 ? 'the agent asked a question and is waiting for an answer' : `the agent asked ${count} questions and is waiting for an answer`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
