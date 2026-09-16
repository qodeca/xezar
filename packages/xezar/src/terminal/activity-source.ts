/**
 * The bridge from a `RunStore` to the terminal (#467, PR 3; analysis § 6(d),
 * `designs/cli-terminal/README.md` §§ 10.1–10.2).
 *
 * One subscription per store, taken BEFORE that store's recovery so nothing is missed, and
 * detached on teardown. It reads two things and infers everything else from them:
 *
 * - `run` — the record, on every change. Status transitions are compared against the status
 *   this module last saw, never printed from the emit itself. That comparison is the whole
 *   reason the module keeps state: `touch()` fires on every token count, every cost update and
 *   every title refresh, so an unguarded listener prints "started" a few hundred times per task.
 * - `event` — for the facts a record does not carry: which question was asked, what a check
 *   exited with, what an agent's own error said.
 *
 * **A session ending is not a task ending.** A `step-end`, a `session` event or a runner error
 * changes nothing on the table and prints no completion: only the record's own `status` says a
 * task is done, failed or cancelled. The two are genuinely different — an interactive last step
 * ends its turn and stays open for follow-ups, and a failing step can be followed by a repair
 * step — and conflating them is `session-equals-task`, one of AC-06's named breaks.
 *
 * **A failed CHECK is not a failed TASK.** The check prints an `error` line, because a person
 * wants to see it; the failed COUNT in the summary only ever moves for a task whose record
 * ended `failed` (§ 6.3). A task whose check failed and whose repair step then succeeded is not
 * a failure, and reporting it as one is how a summary stops being worth reading.
 *
 * **Recovery is seeded, not replayed.** Attaching before recovery means the listener sees
 * `RunManager.recover()` mark every interrupted task `failed` before resuming it. Those are real
 * record writes and a naive listener prints a row of failures for work that is about to carry
 * on. So every record present at attach is seeded as RECOVERED: its rows appear, its lines and
 * its failed count do not, until the caller says recovery is over. A task created after that
 * point is ordinary and prints everything.
 */

import { entry } from './renderer.ts';
import { RUNNER_IDS, type RunnerId } from '../core/agent-runner.ts';
import { formatCost, formatDuration, formatTokens, type Glyphs } from './format.ts';
import { sanitizeText } from './sanitize.ts';
import { isLeaderSignificant } from '../mcp/event-significance.ts';

import type { WorkflowResultScope } from '@qodeca/xezar-contract';
import type { RunRecord, RunStatus, RunStore, RunEvent, StepState } from '../runs/store.ts';
import type { ActivityEntry, ActivityLevel, TaskState } from './activity.ts';
import type { TerminalEvent } from './event-names.ts';

/**
 * Backend id → product name.
 *
 * The cockpit's `packages/web/src/lib/runner-label.ts` holds the same four pairs and cannot be
 * imported here: `packages/web` is a browser bundle and the service must not depend on it. The
 * type is `Record<RunnerId, string>` for exactly the reason that file gives — a fifth backend is
 * then a compile error here rather than a terminal that quietly prints nothing.
 */
export const RUNNER_PRODUCT_NAME: Record<RunnerId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'pi',
};

function productName(runner: unknown): string | undefined {
  return typeof runner === 'string' && (RUNNER_IDS as readonly string[]).includes(runner)
    ? RUNNER_PRODUCT_NAME[runner as RunnerId]
    : undefined;
}

/** How wide a quoted title or question may be before it is cut. */
const QUOTED_MAX = 120;

export interface ActivitySourceOptions {
  /** Where the lines go. */
  emit(entry: ActivityEntry): void;
  /** Put a task on the live table, or update it. */
  setRow(row: {
    id: string;
    state: TaskState;
    step?: string;
    agent?: string;
    startedAtMs: number;
    title: string;
  }): void;
  /** Take a task off the live table. */
  removeRow(id: string): void;
  /** Count one task OUTCOME that was `failed`. Never called for a failed check step. */
  countFailedTask(): void;
  glyphs: Glyphs;
  /** The cockpit URL, for the continuation line on `needs you` and `failed`. */
  url?: () => string | undefined;
  /** The project id, for the task URL. */
  projectId?: string;
  /** Hide token counts, mirroring `XEZ_HIDE_TOKEN_USAGE=1` in the cockpit. */
  hideTokens?: boolean;
  /** Hide cost, mirroring `XEZ_HIDE_COST=1`. */
  hideCost?: boolean;
}

export interface ActivitySource {
  /**
   * Recovery is over: everything the store says from now on prints normally.
   * Idempotent — a caller that is not sure whether recovery ran may call it twice.
   */
  endRecovery(): void;
  /** Remove every listener this source added. Safe to call twice. */
  detach(): void;
}

interface RunMemory {
  status: RunStatus;
  activity?: string;
  /** True until `endRecovery`, for a record that already existed when we attached. */
  recovering: boolean;
  /** The last error text this run's agent reported, used as the cause of a `failed` line. */
  lastError?: string;
  /** Per check step, the exit code its `check-output` reported. `-1` means "not reported". */
  checkExit: Map<string, number>;
  /** The question text of the ask that parked this run, so `needs you` can quote it. */
  question?: string;
  /** Steps whose `step-start` has already printed, so a retry prints and a replay does not. */
  announced: Set<string>;
}

/**
 * Subscribe to one store. Returns the handle the caller must keep: it is the only way to end
 * the recovery window and the only way to detach.
 */
export function attachRunStoreActivity(store: RunStore, options: ActivitySourceOptions): ActivitySource {
  const memory = new Map<string, RunMemory>();
  let recovering = true;

  // Baseline BEFORE any listener: whatever is on disk already happened, and re-announcing it
  // is the `late-subscribe` failure's mirror image — a terminal full of history on every start.
  for (const run of store.listRuns()) {
    memory.set(run.id, {
      status: run.status,
      ...(run.activity ? { activity: run.activity } : {}),
      recovering: true,
      checkExit: new Map(),
      announced: new Set(),
    });
    if (isLive(run.status)) publishRow(run);
  }

  function taskUrl(id: string): string | undefined {
    const base = options.url?.();
    if (!base || !options.projectId) return undefined;
    return `${base}/p/${options.projectId}/tasks/${id.slice(0, 8)}`;
  }

  function quoted(text: string): string {
    const clean = sanitizeText(text, { maxWidth: QUOTED_MAX, ellipsis: options.glyphs.ellipsis });
    return `${options.glyphs.quoteOpen}${clean}${options.glyphs.quoteClose}`;
  }

  function currentStep(run: RunRecord): StepState | undefined {
    if (run.currentStepId) {
      const named = run.steps.find((s) => s.id === run.currentStepId);
      if (named) return named;
    }
    return run.steps.find((s) => s.status === 'running' || s.status === 'waiting');
  }

  function rowState(run: RunRecord): TaskState {
    switch (run.status) {
      case 'waiting':
        return 'needs you';
      case 'review':
        return 'needs review';
      case 'running':
        return run.activity === 'monitoring' ? 'monitoring' : 'running';
      case 'queued':
        // A queued task waiting out a usage limit is `scheduled`, not merely behind others:
        // it resumes on its own, and the design does not count it as a failure (§ 6.3).
        return run.autoResumeAt ? 'scheduled' : 'queued';
      default:
        return 'running';
    }
  }

  function publishRow(run: RunRecord): void {
    const step = currentStep(run);
    const agent = productName(run.runner);
    options.setRow({
      id: run.id,
      state: rowState(run),
      ...(step?.id ? { step: step.id } : {}),
      ...(agent ? { agent } : {}),
      startedAtMs: Date.parse(run.startedAt ?? run.createdAt) || Date.now(),
      title: run.titleSummary ?? run.title,
    });
  }

  function durationOf(run: RunRecord): string {
    const from = Date.parse(run.startedAt ?? run.createdAt);
    const to = Date.parse(run.finishedAt ?? '') || Date.now();
    return formatDuration(to - from);
  }

  /** `<duration> · <tokens> tokens · <cost>`, dropping the parts a setting hides or we lack. */
  function endingFacts(run: RunRecord): string {
    const parts = [durationOf(run)];
    if (!options.hideTokens && run.tokensUsed > 0) parts.push(`${formatTokens(run.tokensUsed)} tokens`);
    if (!options.hideCost && typeof run.costUsd === 'number' && run.costUsd > 0) {
      parts.push(formatCost(run.costUsd));
    }
    return parts.join(` ${options.glyphs.dot} `);
  }

  function emit(input: {
    level: ActivityLevel;
    run: RunRecord;
    message: string;
    event: TerminalEvent;
    continuation?: readonly string[];
    fields?: ActivityEntry['fields'];
  }): void {
    options.emit(entry({
      at: new Date(),
      level: input.level,
      ...(options.projectId ? { projectId: options.projectId } : {}),
      subject: input.run.id.slice(0, 8),
      message: input.message,
      event: input.event,
      ...(input.continuation ? { continuation: input.continuation } : {}),
      fields: [['run', input.run.id.slice(0, 8)], ...(input.fields ?? [])],
    }));
  }

  function onRun(run: RunRecord): void {
    const known = memory.get(run.id);
    if (!known) {
      // A task xezar has never seen: it was just created, so it is `queued` and says so.
      memory.set(run.id, {
        status: run.status,
        ...(run.activity ? { activity: run.activity } : {}),
        recovering: false,
        checkExit: new Map(),
        announced: new Set(),
      });
      if (isLive(run.status)) publishRow(run);
      announceStatus(run, undefined, false);
      return;
    }

    const previous = known.status;
    const previousActivity = known.activity;
    known.status = run.status;
    known.activity = run.activity;

    if (isLive(run.status)) publishRow(run);
    else options.removeRow(run.id);

    // The whole point of remembering: `touch()` fires for a token count too, and a status that
    // did not move is not news. A `monitoring` flip moves the row and prints nothing.
    if (previous === run.status) {
      if (previousActivity !== run.activity) return;
      return;
    }
    announceStatus(run, previous, known.recovering);
  }

  function announceStatus(run: RunRecord, previous: RunStatus | undefined, seeded: boolean): void {
    const memoryEntry = memory.get(run.id);
    const url = taskUrl(run.id);
    const dash = options.glyphs.dash;
    const dot = options.glyphs.dot;

    // A seeded record is still catching up from the previous process. Its row is right; its
    // history is not news, and the `failed` a restart writes before resuming is not an outcome.
    if (seeded) return;

    switch (run.status) {
      case 'queued': {
        if (previous !== undefined) return; // a re-queue is not a new task
        emit({
          level: 'info',
          run,
          message: `queued ${dash} ${quoted(run.titleSummary ?? run.title)}`,
          event: 'task.queued',
          fields: [['title', sanitizeText(run.titleSummary ?? run.title, { maxWidth: 200 })]],
        });
        return;
      }
      case 'running': {
        if (previous === 'waiting') {
          emit({
            level: 'info',
            run,
            message: `answered ${dash} running again`,
            event: 'question.answered',
          });
          if (memoryEntry) memoryEntry.question = undefined;
          return;
        }
        if (previous === 'running') return;
        const step = currentStep(run) ?? run.steps.find((s) => s.status === 'pending');
        const agent = productName(run.runner);
        const facts = [step?.id, agent].filter((v): v is string => !!v).join(` ${dot} `);
        emit({
          level: 'info',
          run,
          message: `started${facts ? ` ${dash} ${facts}` : ''}`,
          event: 'task.started',
          fields: [
            ...(step?.id ? ([['step', step.id]] as const) : []),
            ...(run.runner ? ([['agent', run.runner]] as const) : []),
          ],
        });
        return;
      }
      case 'waiting': {
        const question = memoryEntry?.question;
        // The catalog's split (#460): a park that follows a structured question is
        // `question.asked`; a park with none is `task.blocked` — the task cannot go on without
        // input, but nobody asked anything a person could answer by picking an option.
        emit({
          level: 'warn',
          run,
          message: question ? `needs you ${dash} ${quoted(question)}` : `needs you ${dash} waiting for an answer`,
          event: question ? 'question.asked' : 'task.blocked',
          ...(url ? { continuation: [url] } : {}),
          fields: [
            ...(question ? ([['question', sanitizeText(question, { maxWidth: 200 })]] as const) : []),
            ...(url ? ([['url', url]] as const) : []),
          ],
        });
        return;
      }
      case 'review': {
        emit({
          level: 'info',
          run,
          message: `needs review ${dash} ${endingFacts(run)}`,
          event: 'result.ready',
          fields: durationFields(run, options),
        });
        return;
      }
      case 'done': {
        emit({
          level: 'info',
          run,
          message: `done ${dash} ${endingFacts(run)}`,
          event: 'task.done',
          fields: durationFields(run, options),
        });
        return;
      }
      case 'cancelled': {
        emit({
          level: 'info',
          run,
          message: `cancelled ${dash} ${durationOf(run)}`,
          event: 'task.cancelled',
          fields: durationFields(run, options),
        });
        return;
      }
      case 'failed': {
        const cause = failureCause(run, memoryEntry, options);
        options.countFailedTask();
        emit({
          level: 'error',
          run,
          message: `failed ${dash} ${cause.text}`,
          event: 'task.failed',
          ...(url ? { continuation: [url] } : {}),
          fields: [
            ...(cause.exit !== undefined ? ([['exit', cause.exit]] as const) : []),
            ...(cause.signal ? ([['signal', cause.signal]] as const) : []),
            ['reason', cause.reason],
            ...(url ? ([['url', url]] as const) : []),
          ],
        });
        return;
      }
    }
  }

  function onEvent(payload: { runId: string; event: RunEvent }): void {
    const { runId, event } = payload;
    const known = memory.get(runId);
    const run = store.getRun(runId);
    if (!known || !run) return;
    const dash = options.glyphs.dash;
    const dot = options.glyphs.dot;

    switch (event.type) {
      case 'ask.requested': {
        // Remember the question so the `waiting` transition can quote it. The transition is
        // what prints: the ask and the park are two writes, and printing both is a duplicate.
        const questions = event.questions;
        const first = Array.isArray(questions) ? questions[0] : undefined;
        const text = first && typeof first === 'object' ? (first as { question?: unknown }).question : undefined;
        if (typeof text === 'string') known.question = text;
        return;
      }
      case 'error': {
        // The runner's own error. Remembered as the cause of the `failed` line that follows,
        // not printed here: a session that errors and is retried never failed the task.
        if (typeof event.message === 'string') known.lastError = event.message;
        return;
      }
      case 'check-output': {
        if (typeof event.stepId === 'string' && typeof event.exitCode === 'number') {
          known.checkExit.set(event.stepId, event.exitCode);
        }
        return;
      }
      case 'step-start': {
        if (known.recovering) return;
        const stepId = typeof event.stepId === 'string' ? event.stepId : undefined;
        if (!stepId) return;
        const index = run.steps.findIndex((s) => s.id === stepId);
        if (index < 0) return;
        const step = run.steps[index];
        if (!step || step.kind !== 'agent') return;
        // The first agent step of a task is already announced by the `running` transition.
        if (index === run.steps.findIndex((s) => s.kind === 'agent') && !known.announced.has(stepId)) {
          known.announced.add(stepId);
          return;
        }
        known.announced.add(stepId);
        const agent = productName(step.backend ?? run.runner);
        emit({
          level: 'info',
          run,
          message: `step ${index + 1}/${run.steps.length} ${step.id} started${agent ? ` ${dot} ${agent}` : ''}`,
          event: 'step.started',
          fields: [
            ['step', step.id],
            ['index', index + 1],
            ['total', run.steps.length],
            ...(agent ? ([['agent', step.backend ?? run.runner ?? '']] as const) : []),
          ],
        });
        return;
      }
      case 'step-end': {
        if (known.recovering) return;
        const stepId = typeof event.stepId === 'string' ? event.stepId : undefined;
        if (!stepId) return;
        const step = run.steps.find((s) => s.id === stepId);
        // Checks only. An AGENT step ending is a session ending, and a session ending is not a
        // task ending — the run record's own status is the only thing that says that.
        if (!step || step.kind !== 'check') return;
        const status = typeof event.status === 'string' ? event.status : step.status;
        const started = Date.parse(step.startedAt ?? '');
        const finished = Date.parse(step.finishedAt ?? '') || Date.now();
        const duration = Number.isNaN(started) ? undefined : formatDuration(finished - started);
        const durationMs = Number.isNaN(started) ? undefined : finished - started;
        // The same scope the catalog stamps on its gate row, so both surfaces agree on which
        // passes are routine. A definition without one is a stage gate, as there.
        const resultScope: WorkflowResultScope =
          run.workflowDef?.steps.find((candidate) => candidate.id === step.id)?.resultScope ?? 'stage';
        if (status === 'done') {
          // A routine successful check wakes no leader (`isLeaderSignificant`), and it is not
          // news in the terminal either: it drops to `debug`, where `--log-level debug` finds it.
          const significant = isLeaderSignificant({ kind: 'gate.passed', gate: { stepId: step.id, resultScope } });
          emit({
            level: significant ? 'info' : 'debug',
            run,
            message: `check ${step.id} passed${duration ? ` ${dash} ${duration}` : ''}`,
            event: 'gate.passed',
            fields: [
              ['step', step.id],
              ['result_scope', resultScope],
              ...(durationMs !== undefined ? ([['duration_ms', durationMs]] as const) : []),
            ],
          });
          return;
        }
        if (status !== 'failed') return;
        const exit = known.checkExit.get(stepId);
        // `-1` is what the runner records when it never saw a code (a spawn failure). Printing
        // `exit -1` invents a number; printing nothing loses the fact. `exit unknown` is the
        // honest third answer, and `invented-exit-zero` is the named break for getting it wrong.
        const exitText = exit === undefined || exit < 0 ? 'exit unknown' : `exit ${exit}`;
        emit({
          level: 'error',
          run,
          message: `check ${step.id} failed ${dash} ${exitText}${duration ? ` ${dot} ${duration}` : ''}`,
          event: 'gate.failed',
          fields: [
            ['step', step.id],
            ['result_scope', resultScope],
            ['exit', exit === undefined || exit < 0 ? 'unknown' : exit],
            ...(durationMs !== undefined ? ([['duration_ms', durationMs]] as const) : []),
          ],
        });
        return;
      }
      default:
        return;
    }
  }

  function onDeleted(id: string): void {
    memory.delete(id);
    options.removeRow(id);
  }

  store.on('run', onRun);
  store.on('event', onEvent);
  store.on('deleted', onDeleted);

  let detached = false;
  return {
    endRecovery(): void {
      if (!recovering) return;
      recovering = false;
      for (const known of memory.values()) known.recovering = false;
    },
    detach(): void {
      if (detached) return;
      detached = true;
      store.off('run', onRun);
      store.off('event', onEvent);
      store.off('deleted', onDeleted);
      memory.clear();
    },
  };
}

function isLive(status: RunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting' || status === 'review';
}

function durationFields(
  run: RunRecord,
  options: Pick<ActivitySourceOptions, 'hideTokens' | 'hideCost'>,
): ActivityEntry['fields'] {
  const from = Date.parse(run.startedAt ?? run.createdAt);
  const to = Date.parse(run.finishedAt ?? '') || Date.now();
  const fields: Array<readonly [string, string | number | boolean | undefined]> = [];
  if (!Number.isNaN(from)) fields.push(['duration_ms', to - from]);
  if (!options.hideTokens && run.tokensUsed > 0) fields.push(['tokens', run.tokensUsed]);
  if (!options.hideCost && typeof run.costUsd === 'number' && run.costUsd > 0) {
    fields.push(['cost_usd', Math.floor(run.costUsd * 100) / 100]);
  }
  return fields;
}

/**
 * Why a task failed, in the agent's own words where there are any.
 *
 * Three shapes the design names, and the rule behind all three: **a code or a signal is printed
 * only when it was observed**. There is no uniform raw process exit code on every agent session,
 * so `exit code not reported` is a real answer and `exit 0` is never one xezar may invent.
 */
function failureCause(
  run: RunRecord,
  known: RunMemory | undefined,
  options: Pick<ActivitySourceOptions, 'glyphs'>,
): { text: string; reason: string; exit?: number | string; signal?: string } {
  const dot = options.glyphs.dot;
  const agent = productName(run.runner) ?? 'the agent';
  const raw = known?.lastError ?? run.error ?? '';
  const reason = sanitizeText(raw, { maxWidth: 200 }) || 'no reason reported';

  const signal = /\b(SIG[A-Z]+\d*)\b/.exec(raw)?.[1];
  if (signal) {
    return {
      text: `${agent} stopped by signal ${signal}, not sent by xezar`,
      reason,
      signal,
    };
  }
  const code = /\bexit(?:ed with)?(?: code)?\s+(\d{1,3})\b/i.exec(raw)?.[1];
  if (code !== undefined) {
    return { text: `${agent} exited with code ${code}`, reason, exit: Number(code) };
  }
  if (raw !== '') {
    return { text: `${sanitizeText(raw, { maxWidth: 120 })}`, reason, exit: 'unknown' };
  }
  const failedStep = run.steps.find((s) => s.status === 'failed');
  if (failedStep) {
    return { text: `step ${failedStep.id} ${dot} exit code not reported`, reason, exit: 'unknown' };
  }
  return { text: `${agent} stopped ${dot} exit code not reported`, reason, exit: 'unknown' };
}
