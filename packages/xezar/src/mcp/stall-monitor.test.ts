import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { STALL_DEADLINE_RATIO, STALL_QUIET_MS, STALL_TICK_MS, type StallReason } from '@qodeca/xezar-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunStore, type RunRecord } from '../runs/store.ts';
import { StallMonitor, type StallReporter, type StallTimer } from './stall-monitor.ts';

/**
 * #460 § 2, tests T-6 … T-9 of the accepted spec — the advisory stall monitor.
 *
 * Every case drives the REAL `RunStore` and makes the same calls the engine makes (`updateRun` for
 * a status, `updateStep` for a step, `appendEvent`/`emitEphemeral` for a transcript line,
 * `noteActivity` for a check step's output chunk). The clock and the timer are the only fakes:
 * a five-minute window cannot be waited out, and a tick that is not deterministic cannot pin
 * "once per episode".
 *
 * Each describe block names the BREAK it fails against, from the spec's verification table.
 */

const MINUTE = 60_000;
const T0 = Date.parse('2026-09-16T10:00:00.000Z');

/** The catalog, reduced to what the monitor reports through. */
class FakeReporter implements StallReporter {
  readonly stalls: Array<{ runId: string; stepId: string; reason: StallReason; since: string }> = [];
  readonly resumes: Array<{ runId: string; stepId: string }> = [];
  taskStalled(input: { runId: string; stepId: string; reason: StallReason; since: string }): void {
    this.stalls.push(input);
  }
  taskResumed(input: { runId: string; stepId: string }): void {
    this.resumes.push(input);
  }
  reasons(): StallReason[] {
    return this.stalls.map((stall) => stall.reason);
  }
}

/** The interval, under the test's control: `armed` proves the 0→1 / 1→0 arming. */
class FakeTimers {
  ticks: Array<() => void> = [];
  cancelled = 0;
  everyMs: number | undefined;
  schedule = (tick: () => void, everyMs: number): StallTimer => {
    this.everyMs = everyMs;
    this.ticks.push(tick);
    return {
      cancel: () => {
        this.cancelled += 1;
        this.ticks = this.ticks.filter((candidate) => candidate !== tick);
      },
    };
  };
  get armed(): boolean {
    return this.ticks.length > 0;
  }
  /** One round of the interval, as the runtime would fire it. */
  fire(): void {
    for (const tick of [...this.ticks]) tick();
  }
}

let dataDir: string;
let store: RunStore;
let report: FakeReporter;
let timers: FakeTimers;
let monitor: StallMonitor;
let clock: number;

function attach(): StallMonitor {
  return StallMonitor.attach({ store, report, now: () => clock, schedule: timers.schedule });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'xez-stall-monitor-'));
  store = RunStore.open(dataDir);
  report = new FakeReporter();
  timers = new FakeTimers();
  clock = T0;
  monitor = attach();
});

afterEach(() => {
  monitor.detach();
  // Flush before the directory goes: the store's debounced save would otherwise log an ENOENT
  // after the file ends, which vitest turns into a teardown error (see event-catalog.test.ts).
  store.flush();
  rmSync(dataDir, { recursive: true, force: true });
});

function createRun(kinds: Array<'agent' | 'check'> = ['agent']): RunRecord {
  return store.createRun({
    title: 'fix the login bug',
    workflow: 'quick-task',
    task: 'fix the login bug',
    steps: kinds.map((kind, i) => ({ id: `step-${i}`, name: `Step ${i}`, kind })),
  });
}

/** A run executing its first step, with the engine's own progress stamp (#460) when finite. */
function startedRun(options: { timeoutMs?: number | null; kinds?: Array<'agent' | 'check'> } = {}): RunRecord {
  const run = createRun(options.kinds);
  const startedAt = new Date(clock).toISOString();
  store.updateRun(run.id, { status: 'running', startedAt });
  const effectiveTimeoutMs = options.timeoutMs === undefined ? null : options.timeoutMs;
  store.updateStep(run.id, run.steps[0]!.id, {
    status: 'running',
    iterations: 1,
    startedAt,
    progress: {
      lastActivityAt: null,
      effectiveTimeoutMs,
      deadlineAt: effectiveTimeoutMs === null ? null : new Date(clock + effectiveTimeoutMs).toISOString(),
    },
  });
  return run;
}

function stepOf(run: RunRecord): RunRecord['steps'][number] {
  const found = store.getRun(run.id)?.steps[0];
  if (!found) throw new Error('step gone');
  return found;
}

function advance(ms: number): void {
  clock += ms;
}

// ---- T-6: silence -----------------------------------------------------------------------------

describe('T-6 the quiet window (break: reset on a heartbeat, ignore check output chunks, or compare a quiet time in seconds as milliseconds)', () => {
  it('says nothing before the window and warns on the first tick after it', () => {
    const run = startedRun();

    advance(STALL_QUIET_MS - 1);
    timers.fire();
    expect(report.stalls).toEqual([]);

    advance(1);
    timers.fire();
    expect(report.reasons()).toEqual(['silence']);
    expect(report.stalls[0]).toMatchObject({ runId: run.id, stepId: 'step-0' });
  });

  it('warns at most one tick late, never earlier than the window', () => {
    startedRun();
    // The worst case: the window expires just after a tick, so the warning waits a whole one.
    advance(STALL_QUIET_MS - STALL_TICK_MS);
    timers.fire();
    expect(report.stalls).toEqual([]);
    advance(STALL_TICK_MS);
    timers.fire();
    expect(report.reasons()).toEqual(['silence']);
  });

  it('measures a step that has produced nothing from its own start, not from zero', () => {
    const run = startedRun();
    // Break "compare seconds as milliseconds": 5 minutes IS 300 000 ms, and 300 s would fire here.
    advance(300);
    timers.fire();
    expect(report.stalls).toEqual([]);

    advance(STALL_QUIET_MS);
    timers.fire();
    expect(report.stalls[0]?.since).toBe(stepOf(run).startedAt);
  });

  it('is re-armed by agent text and by tool traffic', () => {
    const run = startedRun();
    for (const event of [{ type: 'text', text: 'working' }, { type: 'tool-call', name: 'Bash' }]) {
      advance(STALL_QUIET_MS - MINUTE);
      store.appendEvent(run.id, event);
      timers.fire();
      expect(report.stalls).toEqual([]);
    }
    advance(STALL_QUIET_MS);
    timers.fire();
    expect(report.reasons()).toEqual(['silence']);
  });

  it('is re-armed by the live delta frames that never reach disk', () => {
    const run = startedRun();
    advance(STALL_QUIET_MS - MINUTE);
    store.emitEphemeral(run.id, { type: 'item.delta', itemId: 'i1', field: 'text', delta: 'x' });
    advance(MINUTE + 1);
    timers.fire();
    expect(report.stalls).toEqual([]);
  });

  it('is re-armed by a check step OUTPUT CHUNK, which no event carries until the command exits', () => {
    // The named break: a monitor reading only the event bus calls every long `npm test` stalled,
    // because `check-output` is written once, at exit.
    const run = startedRun({ kinds: ['check'] });
    for (let i = 0; i < 4; i++) {
      advance(STALL_QUIET_MS - MINUTE);
      store.noteActivity(run.id, 'step-0');
      timers.fire();
    }
    expect(report.stalls).toEqual([]);
    advance(STALL_QUIET_MS);
    timers.fire();
    expect(report.reasons()).toEqual(['silence']);
  });

  // One case per excluded type, each REPEATING inside the window: the named break is a heartbeat
  // being counted, and a heartbeat that repeats every minute makes a quiet step look busy for
  // ever. A single occurrence would not catch it — the other five minutes would still elapse.
  it.each([
    'note',
    'lifecycle',
    'token-usage',
    'cost',
    'usage.updated',
    'step-start',
    'step-end',
    'session.started',
    'ask.requested',
    'user-message',
  ])('is NOT re-armed by a repeating %s frame', (type) => {
    const run = startedRun();
    for (let i = 0; i < 10; i++) {
      advance(MINUTE);
      store.appendEvent(run.id, { type, message: 'automatic monitoring wake-up (1/40)' });
      timers.fire();
    }
    expect(report.reasons()).toEqual(['silence']);
  });

  it('records the quiet observation on the step, with the real instant it started from', () => {
    const run = startedRun();
    advance(2 * MINUTE);
    store.appendEvent(run.id, { type: 'text', text: 'thinking' });
    const activityAt = new Date(clock).toISOString();
    advance(STALL_QUIET_MS);
    timers.fire();

    expect(stepOf(run).progress).toMatchObject({
      lastActivityAt: activityAt,
      stall: { reason: 'silence', since: activityAt, observedAt: new Date(clock).toISOString() },
    });
  });
});

// ---- T-7: the deadline ------------------------------------------------------------------------

describe('T-7 the deadline warning (break: use inactivity as the condition for it, or treat a null timeout as a deadline of zero)', () => {
  it('warns once when the finite timeout is 80 % spent', () => {
    const limit = 30 * MINUTE;
    startedRun({ timeoutMs: limit });

    advance(limit * STALL_DEADLINE_RATIO - 1);
    timers.fire();
    expect(report.reasons()).not.toContain('timeout-near');

    advance(1);
    timers.fire();
    expect(report.reasons().filter((reason) => reason === 'timeout-near')).toHaveLength(1);

    advance(MINUTE);
    timers.fire();
    advance(MINUTE);
    timers.fire();
    expect(report.reasons().filter((reason) => reason === 'timeout-near')).toHaveLength(1);
  });

  it('warns even while the step is producing output every tick', () => {
    // The named break: making silence a precondition hides the one case a reader most needs — a
    // busy step minutes away from being killed.
    const limit = 10 * MINUTE;
    const run = startedRun({ timeoutMs: limit });
    for (let elapsed = 0; elapsed < limit * STALL_DEADLINE_RATIO + STALL_TICK_MS; elapsed += STALL_TICK_MS) {
      advance(STALL_TICK_MS);
      store.appendEvent(run.id, { type: 'text', text: 'still going' });
      timers.fire();
    }
    expect(report.reasons()).toEqual(['timeout-near']);
    expect(report.stalls[0]?.since).toBe(stepOf(run).startedAt);
  });

  it('never warns about a deadline for an unlimited step, however long it runs', () => {
    // `timeoutMs: null` is the interactive step's "no wall clock". Zero is not a deadline.
    const run = startedRun({ timeoutMs: null });
    for (let i = 0; i < 20; i++) {
      advance(MINUTE);
      store.appendEvent(run.id, { type: 'text', text: 'chatting' });
      timers.fire();
    }
    expect(report.reasons()).toEqual([]);
  });

  it('never warns about a deadline when the step recorded no progress at all', () => {
    const run = createRun();
    const startedAt = new Date(clock).toISOString();
    store.updateRun(run.id, { status: 'running', startedAt });
    store.updateStep(run.id, 'step-0', { status: 'running', iterations: 1, startedAt });
    advance(4 * 60 * MINUTE);
    timers.fire();
    // Quiet, yes — but "unknown timeout" produced no deadline warning, only the silence one.
    expect(report.reasons()).toEqual(['silence']);
  });

  it('keeps the deadline observation on the record after activity returns', () => {
    const limit = 10 * MINUTE;
    const run = startedRun({ timeoutMs: limit });
    // Past both the quiet window (5 min) and the 80 % mark of a 10-minute limit (8 min).
    advance(limit * STALL_DEADLINE_RATIO + MINUTE);
    timers.fire();
    expect(report.reasons()).toEqual(['silence', 'timeout-near']);

    store.appendEvent(run.id, { type: 'text', text: 'back' });
    timers.fire();
    expect(report.resumes).toHaveLength(1);
    // Resumed, and STILL near its deadline: the clock did not stop when the step spoke again.
    expect(stepOf(run).progress?.stall).toMatchObject({ reason: 'timeout-near' });
  });
});

// ---- T-8: what is observed, and for how long --------------------------------------------------

describe('T-8 the observed set (break: include every running record regardless of monitoring, or leave the timer behind after disposal)', () => {
  it('ignores a queued, waiting, review or terminal run', () => {
    for (const status of ['queued', 'waiting', 'review', 'done', 'failed', 'cancelled'] as const) {
      const run = startedRun();
      store.updateRun(run.id, { status });
      advance(STALL_QUIET_MS * 2);
      timers.fire();
      expect(report.stalls, `status ${status}`).toEqual([]);
    }
  });

  it('ignores a run that declared itself monitoring its own downstream work', () => {
    const run = startedRun();
    store.updateRun(run.id, { activity: 'monitoring' });
    advance(STALL_QUIET_MS * 3);
    timers.fire();
    expect(report.stalls).toEqual([]);

    // …and picks it up again the moment the agent is working itself.
    store.updateRun(run.id, { activity: undefined });
    advance(STALL_QUIET_MS);
    timers.fire();
    expect(report.reasons()).toEqual(['silence']);
  });

  it('warns again after a resumed episode goes quiet a second time', () => {
    const run = startedRun();
    advance(STALL_QUIET_MS);
    timers.fire();
    store.appendEvent(run.id, { type: 'text', text: 'back' });
    timers.fire();
    advance(STALL_QUIET_MS);
    timers.fire();

    expect(report.reasons()).toEqual(['silence', 'silence']);
    expect(report.resumes).toHaveLength(1);
  });

  it('arms the timer only while something executes, and disarms when nothing does', () => {
    expect(timers.armed).toBe(false);
    const run = startedRun();
    expect(timers.armed).toBe(true);
    expect(timers.everyMs).toBe(STALL_TICK_MS);

    store.updateStep(run.id, 'step-0', { status: 'done' });
    store.updateRun(run.id, { status: 'done' });
    timers.fire();
    expect(timers.armed).toBe(false);
  });

  it('leaves no timer and no listener behind after detach', () => {
    const run = startedRun();
    expect(timers.armed).toBe(true);
    monitor.detach();
    expect(timers.armed).toBe(false);

    // Nothing this monitor created can fire now — and the store has stopped reaching it.
    advance(STALL_QUIET_MS * 10);
    store.appendEvent(run.id, { type: 'text', text: 'late' });
    timers.fire();
    expect(report.stalls).toEqual([]);
    monitor = attach();
  });

  it('keeps two projects apart: activity in one does not re-arm the other', () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'xez-stall-monitor-b-'));
    const otherStore = RunStore.open(otherDir);
    const otherReport = new FakeReporter();
    const otherTimers = new FakeTimers();
    const other = StallMonitor.attach({
      store: otherStore,
      report: otherReport,
      now: () => clock,
      schedule: otherTimers.schedule,
    });
    try {
      const quiet = startedRun();
      const busy = otherStore.createRun({ title: 'b', workflow: 'quick-task', task: 'b', steps: [{ id: 'step-0', name: 'S', kind: 'agent' }] });
      otherStore.updateRun(busy.id, { status: 'running', startedAt: new Date(clock).toISOString() });
      otherStore.updateStep(busy.id, 'step-0', { status: 'running', iterations: 1, startedAt: new Date(clock).toISOString() });

      for (let i = 0; i < 12; i++) {
        advance(MINUTE);
        otherStore.appendEvent(busy.id, { type: 'text', text: 'busy' });
        timers.fire();
        otherTimers.fire();
      }
      expect(otherReport.stalls).toEqual([]);
      expect(report.stalls.map((stall) => stall.runId)).toEqual([quiet.id]);
    } finally {
      other.detach();
      otherStore.flush();
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

// ---- T-9: it changes nothing, and recovery is honest -------------------------------------------

describe('T-9 advisory only and honest recovery (break: cancel the task on a stall, or rebuild lastActivityAt from now without marking the uncertainty)', () => {
  it('changes no status, no timeout and no deadline when it warns', () => {
    const limit = 10 * MINUTE;
    const run = startedRun({ timeoutMs: limit });
    const before = store.getRun(run.id)!;
    const deadlineBefore = before.steps[0]!.progress?.deadlineAt;

    advance(STALL_QUIET_MS * 3);
    timers.fire();
    expect(report.stalls.length).toBeGreaterThan(0);

    const after = store.getRun(run.id)!;
    expect(after.status).toBe('running');
    expect(after.steps[0]!.status).toBe('running');
    expect(after.steps[0]!.progress?.deadlineAt).toBe(deadlineBefore);
    expect(after.steps[0]!.progress?.effectiveTimeoutMs).toBe(limit);
    expect(after.finishedAt).toBeUndefined();
    expect(after.error).toBeUndefined();
  });

  it('makes no second event and no second write while the same condition holds', () => {
    const run = startedRun();
    advance(STALL_QUIET_MS);
    timers.fire();
    const observedAt = stepOf(run).progress?.stall?.observedAt;

    for (let i = 0; i < 5; i++) {
      advance(STALL_TICK_MS);
      timers.fire();
    }
    expect(report.reasons()).toEqual(['silence']);
    // Not re-stamped either: a per-tick snapshot would bump the task version forever.
    expect(stepOf(run).progress?.stall?.observedAt).toBe(observedAt);
  });

  it('keeps the parked floor fresh while another task holds the clock open', () => {
    // The single-run case above is also covered by the re-arm, because a lone parked run stops
    // the timer. This one cannot be: a SECOND run keeps ticking throughout, so the only thing
    // that can save the parked one is the pause being re-stamped on every tick.
    const parked = startedRun();
    const busy = startedRun();
    advance(MINUTE);
    store.appendEvent(parked.id, { type: 'text', text: 'asking' });
    store.updateRun(parked.id, { status: 'waiting' });
    store.updateStep(parked.id, 'step-0', { status: 'waiting' });

    for (let i = 0; i < 120; i++) {
      advance(30_000);
      store.appendEvent(busy.id, { type: 'text', text: 'busy' });
      timers.fire();
    }
    expect(report.stalls).toEqual([]);

    store.updateRun(parked.id, { status: 'running' });
    store.updateStep(parked.id, 'step-0', { status: 'running' });
    timers.fire();
    expect(report.stalls).toEqual([]);

    advance(STALL_QUIET_MS);
    store.appendEvent(busy.id, { type: 'text', text: 'busy' });
    timers.fire();
    expect(report.stalls.map((stall) => stall.runId)).toEqual([parked.id]);
  });

  it('a step it has never observed is unknown at boot, not stalled at boot', () => {
    // The named break, exactly: a monitor attaching to a run that started hours ago must not
    // publish a retrospective stall, and must not backfill `lastActivityAt` with "now" either.
    monitor.detach();
    const run = createRun();
    const longAgo = new Date(clock - 4 * 60 * MINUTE).toISOString();
    store.updateRun(run.id, { status: 'running', startedAt: longAgo });
    store.updateStep(run.id, 'step-0', { status: 'running', iterations: 1, startedAt: longAgo });
    // No `progress` at all: this record predates the field, which is the honest unknown case.
    store.updateStep(run.id, 'step-0', { progress: undefined });
    monitor = attach();

    timers.fire();
    expect(report.stalls).toEqual([]);
    expect(stepOf(run).progress?.lastActivityAt ?? null).toBeNull();

    // It starts observing from the attach, so the first possible warning is a whole window away.
    advance(STALL_QUIET_MS - 1);
    timers.fire();
    expect(report.stalls).toEqual([]);
    advance(1);
    timers.fire();
    expect(report.reasons()).toEqual(['silence']);
    // Still unknown: the warning says when the monitor started watching, never a guessed instant.
    expect(stepOf(run).progress?.lastActivityAt).toBeNull();
  });

  it('a task that waited an hour for a person is not stalled the moment it comes back', () => {
    // The mirror of the boot rule: the monitor WATCHED this run stop executing, so neither the
    // step's own start nor the activity it recorded before the park describes the parked hour.
    const run = startedRun();
    advance(MINUTE);
    store.appendEvent(run.id, { type: 'text', text: 'asking' });
    advance(STALL_QUIET_MS);
    timers.fire();
    expect(report.reasons()).toEqual(['silence']);

    store.updateRun(run.id, { status: 'waiting' });
    store.updateStep(run.id, 'step-0', { status: 'waiting' });
    timers.fire();
    advance(60 * MINUTE);
    timers.fire();

    // Answered, and working again on the SAME step and episode.
    store.updateRun(run.id, { status: 'running' });
    store.updateStep(run.id, 'step-0', { status: 'running' });
    timers.fire();
    expect(report.reasons()).toEqual(['silence']);

    // Only a fresh quiet window earns the next warning.
    advance(STALL_QUIET_MS - MINUTE);
    timers.fire();
    expect(report.reasons()).toEqual(['silence']);
    advance(MINUTE);
    timers.fire();
    expect(report.reasons()).toEqual(['silence', 'silence']);
  });

  it('keeps a recorded activity instant across a restart, and still restarts its own clock', () => {
    const run = startedRun();
    advance(MINUTE);
    store.appendEvent(run.id, { type: 'text', text: 'working' });
    advance(STALL_QUIET_MS);
    timers.fire();
    const recorded = stepOf(run).progress?.lastActivityAt;
    expect(recorded).toBe(new Date(T0 + MINUTE).toISOString());

    // Restart. The recorded instant survives on the record — it is what a leader reads to see
    // when the step last did anything — but it does NOT let the new monitor warn about a span it
    // was not watching, so the clock starts again at the attach.
    monitor.detach();
    monitor = attach();
    const restartedAt = new Date(clock).toISOString();
    timers.fire();
    expect(report.reasons()).toEqual(['silence']);
    expect(stepOf(run).progress?.lastActivityAt).toBe(recorded);

    advance(STALL_QUIET_MS - 1);
    timers.fire();
    expect(report.reasons()).toEqual(['silence']);
    advance(1);
    timers.fire();
    expect(report.reasons()).toEqual(['silence', 'silence']);
    expect(report.stalls[1]?.since).toBe(restartedAt);
  });

  it('clears a stall from the record when the episode ends, and publishes no resume for it', () => {
    const run = startedRun();
    advance(STALL_QUIET_MS);
    timers.fire();
    expect(stepOf(run).progress?.stall).toBeTruthy();

    store.updateStep(run.id, 'step-0', { status: 'failed' });
    store.updateRun(run.id, { status: 'failed' });
    timers.fire();

    expect(stepOf(run).progress?.stall).toBeUndefined();
    expect(report.resumes).toEqual([]);
    // The history is the journal's job, not the record's: the stall row was already published.
    expect(report.reasons()).toEqual(['silence']);
  });

  it('clears the finished step when a second step starts between ticks and when the run ends', () => {
    const run = startedRun({ kinds: ['agent', 'agent'] });
    advance(STALL_QUIET_MS);
    timers.fire();
    expect(store.getRun(run.id)?.steps[0]?.progress?.stall?.reason).toBe('silence');

    store.updateStep(run.id, 'step-0', { status: 'done', finishedAt: new Date(clock).toISOString() });
    store.updateStep(run.id, 'step-1', {
      status: 'running',
      iterations: 1,
      startedAt: new Date(clock).toISOString(),
    });
    timers.fire();

    expect(store.getRun(run.id)?.steps[0]?.progress?.stall).toBeUndefined();

    store.updateStep(run.id, 'step-1', { status: 'done', finishedAt: new Date(clock).toISOString() });
    store.updateRun(run.id, { status: 'done', finishedAt: new Date(clock).toISOString() });
    timers.fire();

    expect(store.getRun(run.id)?.steps[0]?.progress?.stall).toBeUndefined();
  });

  it('treats a retry of the same step as a new episode with its own baseline', () => {
    const run = startedRun();
    advance(STALL_QUIET_MS);
    timers.fire();
    expect(report.reasons()).toEqual(['silence']);

    const retryAt = new Date(clock).toISOString();
    store.updateStep(run.id, 'step-0', { status: 'running', iterations: 2, startedAt: retryAt });
    timers.fire();
    expect(report.reasons()).toEqual(['silence']);

    advance(STALL_QUIET_MS);
    timers.fire();
    expect(report.reasons()).toEqual(['silence', 'silence']);
    expect(report.stalls[1]?.since).toBe(retryAt);
  });
});
