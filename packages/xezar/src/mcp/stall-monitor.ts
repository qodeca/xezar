import {
  STALL_DEADLINE_RATIO,
  STALL_QUIET_MS,
  STALL_TICK_MS,
  type StallReason,
  type StepProgress,
} from '@qodeca/xezar-contract';

import type { RunEvent, RunRecord, RunStore } from '../runs/store.ts';

/**
 * THE ADVISORY STALL MONITOR (#460 § 2).
 *
 * A leader watching a task learns when it finishes, fails, blocks or asks. It learns nothing at
 * all about the long middle — a task that wedged twenty minutes ago and a task that is working
 * hard look identical until one of them ends. This is the missing signal, and it is deliberately
 * the WEAKEST useful one: an observation that something looks quiet, published once when it
 * starts looking quiet and once when it stops.
 *
 * WHAT IT NEVER DOES, because an advisory that acts is no longer advisory. It cancels nothing,
 * interrupts nothing, changes no timeout, touches no lease and moves no run status. A stalled
 * task keeps running to exactly the same end it would have reached with this module deleted.
 * Every transition out of a stall state is listed below, and each one is fired by something that
 * really happens — there is no state here whose only exit is a person noticing it.
 *
 * NO MODEL IS INVOLVED. The two conditions are arithmetic on timestamps; nothing reads a
 * transcript's meaning, and nothing spends a token deciding whether a task is stuck.
 *
 * THE TWO CONDITIONS, independent on purpose:
 *
 *  - `silence`: no real agent activity for `STALL_QUIET_MS`. Its baseline is the last activity,
 *    else the step's start, else — after a restart — the moment this monitor first saw the step.
 *  - `timeout-near`: `STALL_DEADLINE_RATIO` of a FINITE effective timeout is spent. It fires
 *    while output is streaming, because a busy step can still be minutes from being killed;
 *    making inactivity a precondition would hide the case a reader most needs. An unlimited or
 *    unknown timeout produces no deadline warning at all, never a deadline of zero.
 *
 * ONE ROW PER REASON PER EPISODE. An episode is one execution of one step (a retry is a new
 * one). Silence re-arms only after REAL activity, and re-arming publishes `task.resumed`;
 * `timeout-near` fires once and stays fired, because the deadline it warned about does not move
 * when the step starts talking again. That asymmetry is the whole reason the two reasons are
 * tracked separately rather than as one "stalled" flag.
 *
 * THE MONITOR MAY ONLY SPEAK FOR WHAT IT WATCHED. One rule, three floors, and the LATEST of them
 * is where an episode's quiet span starts:
 *
 *  - what the record claims — the step's persisted `progress.lastActivityAt`, else its `startedAt`;
 *  - when this monitor last started watching at all (its attach, and every re-arm of the timer);
 *  - when it last saw THIS run not executing.
 *
 * Each floor exists because of a case the one before it gets wrong. A step found ALREADY RUNNING
 * at attach — after a restart, or when the MCP composition opens late — may carry a `startedAt`
 * four hours old, and taking it would publish a retrospective stall for a span nothing here
 * observed; so the earliest a fresh attach can warn is a full quiet window after the attach. And
 * a run that parked at `waiting` for an hour was not stuck for that hour, however old its own
 * timestamps now look; so the parked instant is re-stamped on every tick and floors whatever the
 * record claims when the run comes back.
 *
 * Every gap in observation is therefore charged to the observer, not to the task. It errs LATE and
 * never early, which is the only safe direction for an advisory: a warning five minutes later than
 * it could have been costs nothing, and one that fires the moment a task returns from waiting for
 * a person is simply wrong.
 *
 * `lastActivityAt` stays `null` — visibly unknown — until real activity arrives. Nothing here
 * backfills it with "now".
 *
 * WHAT COUNTS AS ACTIVITY. Agent transcript progress: text, tool traffic, images, turn
 * boundaries and the live `item.*` frames, plus a check step's output CHUNKS, which reach this
 * module through `RunStore.noteActivity` because the `check-output` record is written only when
 * the command exits. Everything else is excluded by an explicit allowlist rather than a
 * denylist, so a new event type is not silently promoted into a heartbeat: notes, lifecycle and
 * step markers, token/cost counters, session bookkeeping, the monitoring nudge and a human's own
 * message are all NOT the agent doing work.
 *
 * WHAT IS OBSERVED AT ALL. Only a `running` run's `running` steps, and not while the run is in
 * the `monitoring` sub-state — that one is the agent deliberately waiting on its own downstream
 * work and saying so, which is the opposite of stuck. Queued, waiting, review and terminal runs
 * are not observed, so none of them can warn.
 *
 * WHAT IT WRITES, and how little. The journal row is summary-only. The step record gets a
 * `progress` snapshot on TRANSITIONS only — a stall appearing or clearing — never on a tick that
 * changed nothing, because every write bumps the run's version and fans the whole record out
 * over SSE. When an episode ends, a lingering `stall` is cleared from the record: the record
 * says what is true NOW, and a finished step that still reads "stalled" is a lie. The journal
 * keeps the history, which is the right half to keep it in.
 *
 * THE TIMER. One interval per project, armed on the 0→1 executing step and cleared on the 1→0,
 * so a project with nothing running costs nothing and a disposed project leaves no timer behind.
 * It is unref'd: it never holds the process open.
 */

/** Where a stall observation goes — the event catalog, in production. */
export interface StallReporter {
  taskStalled(input: { runId: string; stepId: string; reason: StallReason; since: string }): void;
  taskResumed(input: { runId: string; stepId: string }): void;
}

/** A cancellable repeating timer. Seam so a test can drive the clock itself. */
export interface StallTimer {
  cancel(): void;
}

export interface StallMonitorOptions {
  store: RunStore;
  report: StallReporter;
  /** Wall clock, injectable for tests. */
  now?: () => number;
  /** Timer factory, injectable for tests. Called with the tick function and `STALL_TICK_MS`. */
  schedule?: (tick: () => void, everyMs: number) => StallTimer;
  warn?: (message: string) => void;
}

/**
 * Event types that mean THE AGENT IS DOING WORK. An allowlist, deliberately: a denylist would
 * promote every future event type into a heartbeat by default, and a heartbeat that is not work
 * is exactly how a silence detector stops detecting silence.
 */
const ACTIVITY_EVENT_TYPES: ReadonlySet<string> = new Set([
  // v1 transcript
  'text',
  'tool-call',
  'tool-result',
  'check-output',
  'image',
  // v2 protocol — including the live `item.delta` frames, which never reach disk
  'item.started',
  'item.delta',
  'item.updated',
  'item.completed',
  'turn.started',
  'turn.completed',
  'plan.updated',
  'permission.requested',
  'permission.resolved',
]);

/** One execution of one step, as the monitor remembers it between ticks. */
interface Episode {
  readonly runId: string;
  readonly stepId: string;
  /** Identity of THIS execution: a retry of the same step is a different episode. */
  readonly key: string;
  /** The instant the current quiet span is measured from. Always a real observed instant. */
  quietSince: number;
  /** Real agent activity only — `null` while none has ever been seen for this episode. */
  lastActivityAt: string | null;
  silenceStalled: boolean;
  deadlineWarned: boolean;
  /** The `timeout-near` observation, once it has fired, so a later resume cannot erase it. */
  deadlineObservation?: { since: string; observedAt: string };
}

function episodeKey(step: RunRecord['steps'][number]): string {
  return `${step.id}\u0000${step.startedAt ?? ''}\u0000${step.iterations}`;
}

/**
 * The step this run is executing right now, if any — the only thing this module looks at.
 *
 * `monitoring` is the agent waiting on its own downstream work and saying so (#490): a declared
 * non-attention state, and warning about it would report a feature as a fault. Queued, waiting,
 * review and every terminal status are excluded by the status test itself.
 */
function executingStep(run: RunRecord): RunRecord['steps'][number] | undefined {
  if (run.status !== 'running' || run.activity === 'monitoring') return undefined;
  return run.steps.find((step) => step.status === 'running');
}

function executingSteps(store: RunStore): Array<{ run: RunRecord; step: RunRecord['steps'][number] }> {
  const out: Array<{ run: RunRecord; step: RunRecord['steps'][number] }> = [];
  for (const run of store.listRuns()) {
    const step = executingStep(run);
    if (step) out.push({ run, step });
  }
  return out;
}

export class StallMonitor {
  readonly #store: RunStore;
  readonly #report: StallReporter;
  readonly #now: () => number;
  readonly #schedule: (tick: () => void, everyMs: number) => StallTimer;
  readonly #warn: (message: string) => void;
  readonly #unsubscribe: Array<() => void> = [];
  /** One episode per run: this engine runs one step of a run at a time. */
  readonly #episodes = new Map<string, Episode>();
  /** Activity instants recorded between ticks — the hot path writes here and nothing else. */
  readonly #activity = new Map<string, number>();
  /**
   * Per run, the instant this monitor SAW it stop executing — parked at `waiting`, gone into
   * `monitoring`, finished. A run that comes back from an hour of waiting was not stuck for that
   * hour, and neither its step's `startedAt` nor a persisted `lastActivityAt` from before the
   * park says so. This is the one thing the monitor knows that the record does not, so it floors
   * the baseline of the next episode with it.
   */
  readonly #pausedAt = new Map<string, number>();
  /** When observation (re)started. The earliest instant this monitor is entitled to speak about
   *  at all — reset on every arm, because a parked clock observes nothing. */
  #observingSince: number;
  #timer: StallTimer | undefined;
  #warned = false;
  #detached = false;

  private constructor(options: StallMonitorOptions) {
    this.#store = options.store;
    this.#report = options.report;
    this.#now = options.now ?? (() => Date.now());
    this.#schedule =
      options.schedule ??
      ((tick, everyMs) => {
        const handle = setInterval(tick, everyMs);
        handle.unref?.();
        return { cancel: () => clearInterval(handle) };
      });
    this.#warn = options.warn ?? ((message) => console.warn(message));
    this.#observingSince = this.#now();
  }

  /** Start observing the project's runs. Writes nothing and publishes nothing on attach. */
  static attach(options: StallMonitorOptions): StallMonitor {
    const monitor = new StallMonitor(options);
    const onRun = (run: RunRecord) => monitor.#guard(() => monitor.#onRun(run));
    const onEvent = (payload: { runId: string; event: RunEvent }) =>
      monitor.#guard(() => monitor.#onEvent(payload.runId, payload.event));
    const onActivity = (payload: { runId: string }) =>
      monitor.#guard(() => monitor.#noteActivity(payload.runId));
    const onDeleted = (runId: string) => {
      monitor.#episodes.delete(runId);
      monitor.#activity.delete(runId);
      monitor.#pausedAt.delete(runId);
    };
    options.store.on('run', onRun);
    options.store.on('event', onEvent);
    options.store.on('activity', onActivity);
    options.store.on('deleted', onDeleted);
    monitor.#unsubscribe.push(
      () => options.store.off('run', onRun),
      () => options.store.off('event', onEvent),
      () => options.store.off('activity', onActivity),
      () => options.store.off('deleted', onDeleted),
    );
    // A xezar that restarted into a live run must start observing it, and this one-off scan is
    // what does that. It publishes nothing: the first evaluation is a whole tick away, and the
    // baseline it will use for a step it has never seen is this instant.
    monitor.#guard(() => {
      if (executingSteps(options.store).length > 0) monitor.#arm();
    });
    return monitor;
  }

  /**
   * Stop observing. Releases every subscription and cancels the timer, so nothing this monitor
   * created can fire afterwards — a late tick against a disposed project is exactly the "delayed
   * timer revives a dead observation" failure the design forbids.
   */
  detach(): void {
    this.#detached = true;
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#timer?.cancel();
    this.#timer = undefined;
    this.#episodes.clear();
    this.#activity.clear();
    this.#pausedAt.clear();
  }

  /** Run one evaluation now. Exposed for tests, which drive the clock rather than waiting. */
  tick(): void {
    this.#guard(() => this.#evaluate());
  }

  // ---- signals -----------------------------------------------------------------------------

  #onEvent(runId: string, event: RunEvent): void {
    if (typeof event.type !== 'string' || !ACTIVITY_EVENT_TYPES.has(event.type)) return;
    this.#noteActivity(runId);
  }

  /** The hot path: one map write, no store read, no evaluation, no event. */
  #noteActivity(runId: string): void {
    // Nothing is executing, so nothing this could be activity OF. Not recording it is also what
    // keeps the map from growing while the timer is parked.
    if (!this.#timer) return;
    this.#activity.set(runId, this.#now());
  }

  /**
   * Arm on the 0→1 executing step. This runs on EVERY store touch — a token counter, a title, a
   * diff stat — so it looks only at the run it was handed: an O(1) test, never a scan of the
   * whole project. Disarming is the tick's job, because the tick already knows the whole active
   * set and a project with nothing running costs at most one more tick before the clock stops.
   */
  #onRun(run: RunRecord): void {
    if (this.#detached || this.#timer || !executingStep(run)) return;
    this.#arm();
  }

  #arm(): void {
    // Observation restarts here. While the clock was parked nothing was watched, so the span
    // before this instant is not evidence of quiet, however old the record's own timestamps are.
    this.#observingSince = this.#now();
    this.#timer = this.#schedule(() => this.tick(), STALL_TICK_MS);
  }

  /** Stop the clock and drop every baseline — nothing is executing, so nothing is being timed. */
  #disarm(): void {
    this.#timer?.cancel();
    this.#timer = undefined;
    this.#endEpisodes(new Set());
    this.#activity.clear();
  }

  // ---- evaluation ----------------------------------------------------------------------------

  #evaluate(): void {
    const now = this.#now();
    // ONE pass over the project's runs produces both halves: what is executing, and — for
    // everything that is not — the fact that at THIS instant it was parked. The second half has
    // to be re-stamped on every tick, not once when a run stops: a run that waits an hour for a
    // person is parked for the whole hour, and a floor recorded only at the start of the wait
    // would leave fifty-nine minutes of it looking like quiet.
    const active: Array<{ run: RunRecord; step: RunRecord['steps'][number] }> = [];
    const live = new Set<string>();
    for (const run of this.#store.listRuns()) {
      const step = executingStep(run);
      if (step) {
        active.push({ run, step });
        live.add(run.id);
      } else {
        this.#pausedAt.set(run.id, now);
      }
    }
    this.#endEpisodes(live);

    for (const { run, step } of active) {
      const episode = this.#episodeFor(run.id, step, now);
      this.#foldActivity(episode, step, now);
      this.#checkSilence(episode, step, now);
      this.#checkDeadline(episode, step, now);
    }
    for (const runId of [...this.#activity.keys()]) {
      if (!live.has(runId)) this.#activity.delete(runId);
    }
    // Nothing left to watch: stop the clock rather than tick forever over an empty set.
    if (active.length === 0) this.#disarm();
  }

  /**
   * The episode for this execution, created on first sight. Creation is where the whole
   * only-speak-for-what-you-watched rule lives — see the header for the three floors and why each
   * of them is there. `lastActivityAt` stays `null` unless the record supplied a real instant.
   */
  #episodeFor(runId: string, step: RunRecord['steps'][number], now: number): Episode {
    const key = episodeKey(step);
    const existing = this.#episodes.get(runId);
    if (existing && existing.key === key) return existing;
    if (existing) this.#endEpisode(runId, existing);
    const recorded = step.progress?.lastActivityAt ?? null;
    const recordedMs = recorded === null ? Number.NaN : Date.parse(recorded);
    const startedMs = Date.parse(step.startedAt ?? '');
    // ONE rule, three floors, all of them "the monitor may only speak for what it watched":
    //  - what the record claims — a persisted activity instant, else the step's own start;
    //  - when this monitor last (re)started watching at all;
    //  - when it last saw THIS run not executing.
    // The latest of those wins, so every gap in observation is charged to the observer rather
    // than to the task. It errs late and never early, which is the only safe direction for an
    // advisory: a warning that arrives five minutes after a restart costs nothing, and one that
    // fires the instant a task comes back from an hour of waiting is simply wrong.
    const claimed = Number.isFinite(recordedMs) ? recordedMs : Number.isFinite(startedMs) ? startedMs : now;
    const fresh: Episode = {
      runId,
      stepId: step.id,
      key,
      quietSince: Math.max(claimed, this.#observingSince, this.#pausedAt.get(runId) ?? 0),
      lastActivityAt: Number.isFinite(recordedMs) ? recorded : null,
      silenceStalled: false,
      deadlineWarned: false,
    };
    this.#episodes.set(runId, fresh);
    return fresh;
  }

  /** Take in whatever activity arrived since the last tick, and publish the resume it earns. */
  #foldActivity(episode: Episode, step: RunRecord['steps'][number], now: number): void {
    const at = this.#activity.get(episode.runId);
    this.#activity.delete(episode.runId);
    if (at === undefined || at <= episode.quietSince) return;
    episode.quietSince = at;
    episode.lastActivityAt = new Date(at).toISOString();
    if (!episode.silenceStalled) return;
    // Real work came back to a step this monitor had called quiet. The deadline warning, if one
    // fired, is untouched: the clock did not stop when the step started talking again.
    episode.silenceStalled = false;
    this.#report.taskResumed({ runId: episode.runId, stepId: episode.stepId });
    this.#writeProgress(episode, step, now);
  }

  #checkSilence(episode: Episode, step: RunRecord['steps'][number], now: number): void {
    if (episode.silenceStalled || now - episode.quietSince < STALL_QUIET_MS) return;
    episode.silenceStalled = true;
    const since = new Date(episode.quietSince).toISOString();
    this.#report.taskStalled({ runId: episode.runId, stepId: episode.stepId, reason: 'silence', since });
    this.#writeProgress(episode, step, now);
  }

  /**
   * The deadline half. It reads the timeout the ENGINE recorded when it spawned the step, never
   * one derived here: `deadlineAt` and `effectiveTimeoutMs` are written together by the step's
   * own start, so an absent pair is an honest "no deadline known" and produces no warning — the
   * unlimited step and the unknown one behave identically, and neither becomes a deadline of zero.
   */
  #checkDeadline(episode: Episode, step: RunRecord['steps'][number], now: number): void {
    if (episode.deadlineWarned) return;
    const { deadlineAt, effectiveTimeoutMs } = step.progress ?? {};
    if (!deadlineAt || effectiveTimeoutMs === null || effectiveTimeoutMs === undefined || effectiveTimeoutMs <= 0) return;
    const deadlineMs = Date.parse(deadlineAt);
    if (!Number.isFinite(deadlineMs)) return;
    const warnAt = deadlineMs - effectiveTimeoutMs * (1 - STALL_DEADLINE_RATIO);
    if (now < warnAt) return;
    episode.deadlineWarned = true;
    const since = new Date(deadlineMs - effectiveTimeoutMs).toISOString();
    episode.deadlineObservation = { since, observedAt: new Date(now).toISOString() };
    this.#report.taskStalled({ runId: episode.runId, stepId: episode.stepId, reason: 'timeout-near', since });
    this.#writeProgress(episode, step, now);
  }

  /** Forget every episode whose run is no longer executing, clearing a stall it left on record. */
  #endEpisodes(live: ReadonlySet<string>): void {
    for (const [runId, episode] of [...this.#episodes]) {
      if (live.has(runId)) continue;
      this.#endEpisode(runId, episode);
    }
  }

  /** End one execution, including a step replaced between two ticks of the same live run. */
  #endEpisode(runId: string, episode: Episode): void {
    this.#episodes.delete(runId);
    if (!episode.silenceStalled && !episode.deadlineWarned) return;
    // The step is over. Its journal rows keep the history; the record must stop claiming a
    // suspicion about something that is no longer running.
    const step = this.#store.getRun(runId)?.steps.find((candidate) => candidate.id === episode.stepId);
    if (!step?.progress?.stall) return;
    const { stall: _cleared, ...rest } = step.progress;
    this.#store.updateStep(runId, episode.stepId, { progress: rest });
  }

  /**
   * Snapshot the episode onto the step. Called ONLY from a transition, and it preserves the
   * engine-written half of the record rather than re-deriving it: the monitor owns the liveness
   * fields, the step's start owns the deadline fields.
   */
  #writeProgress(episode: Episode, step: RunRecord['steps'][number], now: number): void {
    const stall = episode.deadlineWarned
      ? { reason: 'timeout-near' as const, ...(episode.deadlineObservation ?? { since: new Date(now).toISOString(), observedAt: new Date(now).toISOString() }) }
      : episode.silenceStalled
        ? {
            reason: 'silence' as const,
            since: new Date(episode.quietSince).toISOString(),
            observedAt: new Date(now).toISOString(),
          }
        : undefined;
    const progress: StepProgress = {
      lastActivityAt: episode.lastActivityAt,
      effectiveTimeoutMs: step.progress?.effectiveTimeoutMs ?? null,
      deadlineAt: step.progress?.deadlineAt ?? null,
      // Spread conditionally: an explicit `stall: undefined` types a key as always-present that
      // `JSON.stringify` then drops, which is the contract-parity trap this repo has named.
      ...(stall ? { stall } : {}),
    };
    this.#store.updateStep(episode.runId, episode.stepId, { progress });
  }

  /** A monitor problem is never a task problem: warn once, then keep observing. */
  #guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      if (!this.#warned) {
        this.#warned = true;
        const message = err instanceof Error ? err.message : String(err);
        this.#warn(`[xez] MCP stall monitor stopped observing one change (${message}) — the task is unaffected`);
      }
    }
  }
}
