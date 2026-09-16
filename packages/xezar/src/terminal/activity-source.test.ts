/**
 * AC-06 — every task event appears once, from a controlled emission, including a recovered
 * boot store; no token-driven duplicate starts, and no task completion inferred from a session
 * ending.
 *
 * Named breaks proven here: `late-subscribe`, `duplicate-summary`, `session-equals-task`, and
 * AC-07's `invented-exit-zero` for the check-step line.
 *
 * The store is a small fake with the four members this source uses — `listRuns`, `getRun`,
 * `on`, `off` — driving the real `EventEmitter` contract `RunStore` exposes. What is under test
 * is the mapping from those events to lines, and a fake lets a case emit the exact sequence a
 * restart produces without spawning an agent.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { attachRunStoreActivity } from './activity-source.ts';
import { UTF8_GLYPHS } from './format.ts';

import type { ActivityEntry, TaskRow } from './activity.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';

class FakeStore extends EventEmitter {
  readonly records = new Map<string, RunRecord>();

  listRuns(): RunRecord[] {
    return [...this.records.values()];
  }

  getRun(id: string): RunRecord | undefined {
    return this.records.get(id);
  }

  /** Publish a record change the way `touch()` does — the same mutable object, every time. */
  put(record: RunRecord): void {
    this.records.set(record.id, record);
    this.emit('run', record);
  }

  event(runId: string, event: Record<string, unknown>): void {
    this.emit('event', { runId, event: { seq: 1, ts: new Date().toISOString(), ...event } });
  }

  get asStore(): RunStore {
    return this as unknown as RunStore;
  }
}

function record(over: Partial<RunRecord> & Pick<RunRecord, 'id' | 'status'>): RunRecord {
  return {
    title: 'Fix login redirect',
    workflow: 'quick-task',
    task: 'fix it',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    tokensUsed: 0,
    steps: [],
    archived: false,
    runner: 'claude',
    ...over,
  } as RunRecord;
}

function harness(store: FakeStore, options: { projectId?: string } = {}) {
  const entries: ActivityEntry[] = [];
  const rows = new Map<string, TaskRow>();
  let failedTasks = 0;
  const source = attachRunStoreActivity(store.asStore, {
    emit: (e) => entries.push(e),
    setRow: (row) => rows.set(row.id, row as TaskRow),
    removeRow: (id) => rows.delete(id),
    countFailedTask: () => {
      failedTasks++;
    },
    glyphs: UTF8_GLYPHS,
    url: () => 'http://localhost:4322',
    projectId: options.projectId ?? 'beta',
  });
  return {
    source,
    entries,
    rows,
    get failedTasks() {
      return failedTasks;
    },
    events: () => entries.map((e) => e.event),
    messages: () => entries.map((e) => e.message),
  };
}

describe('status transitions', () => {
  it('announces queued, started, review and done exactly once each', () => {
    const store = new FakeStore();
    const h = harness(store);
    h.source.endRecovery();

    store.put(record({ id: 'a12bc345', status: 'queued' }));
    store.put(record({ id: 'a12bc345', status: 'running', steps: [step('implement', 'running')], currentStepId: 'implement' }));
    store.put(record({ id: 'a12bc345', status: 'review', tokensUsed: 96_233 }));
    store.put(record({ id: 'a12bc345', status: 'done', tokensUsed: 96_233, finishedAt: new Date().toISOString() }));

    expect(h.events()).toEqual(['task.queued', 'task.started', 'result.ready', 'task.done']);
    expect(h.messages()[0]).toBe('queued — “Fix login redirect”');
    expect(h.messages()[1]).toBe('started — implement · Claude Code');
    expect(h.messages()[2]).toMatch(/^needs review — /);
  });

  it('prints nothing for a record change that did not move the status', () => {
    // `duplicate-summary`: `touch()` fires on every token count, cost update and title refresh.
    const store = new FakeStore();
    const h = harness(store);
    h.source.endRecovery();
    store.put(record({ id: 'a1', status: 'running' }));
    for (let i = 1; i <= 50; i++) store.put(record({ id: 'a1', status: 'running', tokensUsed: i * 100 }));
    expect(h.events()).toEqual(['task.started']);
  });

  it('prints nothing when a FINISHED record is touched again, and never re-counts the failure', () => {
    // `duplicate-summary`, the half the `running` case hides. `queued` and `running` each have a
    // guard of their own inside the announcer, so removing the status diff leaves them correct
    // by accident. For every ENDING status the diff is the only thing there is — and for
    // `failed` it also guards `countFailedTask()`, so losing it would inflate the number the
    // session summary ends on, which is the one number a person came back to read.
    for (const status of ['waiting', 'review', 'done', 'cancelled', 'failed'] as const) {
      const store = new FakeStore();
      const h = harness(store);
      h.source.endRecovery();
      store.put(record({ id: 'a1', status: 'running' }));
      store.put(record({ id: 'a1', status }));
      const afterArriving = h.events().length;

      for (let i = 1; i <= 20; i++) store.put(record({ id: 'a1', status, tokensUsed: i * 100 }));

      expect(h.events().length, `${status} printed a line for a plain touch`).toBe(afterArriving);
      expect(h.failedTasks, `${status} moved the failed count on a plain touch`).toBe(
        status === 'failed' ? 1 : 0,
      );
    }
  });

  it('a monitoring flip moves the row and prints no line', () => {
    const store = new FakeStore();
    const h = harness(store);
    h.source.endRecovery();
    store.put(record({ id: 'a1', status: 'running' }));
    store.put(record({ id: 'a1', status: 'running', activity: 'monitoring' }));
    expect(h.events()).toEqual(['task.started']);
    expect(h.rows.get('a1')?.state).toBe('monitoring');
  });

  it('a question parks the task, quotes it and carries the task URL', () => {
    const store = new FakeStore();
    const h = harness(store);
    h.source.endRecovery();
    store.put(record({ id: 'b98de765', status: 'running' }));
    store.event('b98de765', {
      type: 'ask.requested',
      questions: [{ header: 'vitest', question: 'Pin vitest to 3.2.4 or allow 3.2.x?' }],
    });
    store.put(record({ id: 'b98de765', status: 'waiting' }));

    const asked = h.entries.at(-1);
    expect(asked?.event).toBe('question.asked');
    expect(asked?.level).toBe('warn');
    expect(asked?.message).toBe('needs you — “Pin vitest to 3.2.4 or allow 3.2.x?”');
    expect(asked?.continuation).toEqual(['http://localhost:4322/p/beta/tasks/b98de765']);
    expect(h.rows.get('b98de765')?.state).toBe('needs you');
  });

  it('says “waiting for an answer” when no structured question was seen', () => {
    const store = new FakeStore();
    const h = harness(store);
    h.source.endRecovery();
    store.put(record({ id: 'c1', status: 'running' }));
    store.put(record({ id: 'c1', status: 'waiting' }));
    expect(h.messages().at(-1)).toBe('needs you — waiting for an answer');
  });

  it('an answer moves the task back to running with its own line', () => {
    const store = new FakeStore();
    const h = harness(store);
    h.source.endRecovery();
    store.put(record({ id: 'c1', status: 'waiting' }));
    store.put(record({ id: 'c1', status: 'running' }));
    expect(h.events().at(-1)).toBe('question.answered');
    expect(h.messages().at(-1)).toBe('answered — running again');
  });

  it('takes a finished task off the table and leaves a live one on it', () => {
    const store = new FakeStore();
    const h = harness(store);
    h.source.endRecovery();
    store.put(record({ id: 'a1', status: 'running' }));
    store.put(record({ id: 'b2', status: 'running' }));
    expect([...h.rows.keys()]).toEqual(['a1', 'b2']);
    store.put(record({ id: 'a1', status: 'done' }));
    expect([...h.rows.keys()]).toEqual(['b2']);
  });

  it('a task waiting out a usage limit is scheduled, not merely queued', () => {
    const store = new FakeStore();
    const h = harness(store);
    h.source.endRecovery();
    store.put(record({ id: 'a1', status: 'queued', autoResumeAt: new Date(Date.now() + 60_000).toISOString() }));
    expect(h.rows.get('a1')?.state).toBe('scheduled');
  });
});

describe('failures', () => {
  it('counts a failed TASK once and carries the task URL', () => {
    const store = new FakeStore();
    const h = harness(store);
    h.source.endRecovery();
    store.put(record({ id: 'b98de765', status: 'running' }));
    store.put(record({ id: 'b98de765', status: 'failed', error: 'Codex stopped' }));
    expect(h.failedTasks).toBe(1);
    const failed = h.entries.at(-1);
    expect(failed?.level).toBe('error');
    expect(failed?.continuation).toEqual(['http://localhost:4322/p/beta/tasks/b98de765']);
  });

  it('says “exit code not reported” rather than inventing a zero', () => {
    // `invented-exit-zero`: there is no guaranteed exit code on every agent session.
    const store = new FakeStore();
    const h = harness(store);
    h.source.endRecovery();
    store.put(record({ id: 'b1', status: 'running', runner: 'codex' }));
    store.put(record({ id: 'b1', status: 'failed', runner: 'codex' }));
    expect(h.messages().at(-1)).toBe('failed — Codex stopped · exit code not reported');
    const fields = Object.fromEntries((h.entries.at(-1)?.fields ?? []).map((f) => [f[0], f[1]]));
    expect(fields.exit).toBe('unknown');
  });

  it('reports a code and a signal only when the agent really reported one', () => {
    const store = new FakeStore();
    const h = harness(store);
    h.source.endRecovery();

    store.put(record({ id: 'c1', status: 'running' }));
    store.event('c1', { type: 'error', message: 'claude exited with code 137' });
    store.put(record({ id: 'c1', status: 'failed' }));
    expect(h.messages().at(-1)).toBe('failed — Claude Code exited with code 137');

    store.put(record({ id: 'd1', status: 'running', runner: 'pi' }));
    store.event('d1', { type: 'error', message: 'stopped by SIGTERM' });
    store.put(record({ id: 'd1', status: 'failed', runner: 'pi' }));
    expect(h.messages().at(-1)).toBe('failed — pi stopped by signal SIGTERM, not sent by xezar');
  });

  it('an agent error alone changes nothing — only the record says a task failed', () => {
    // `session-equals-task`.
    const store = new FakeStore();
    const h = harness(store);
    h.source.endRecovery();
    store.put(record({ id: 'a1', status: 'running' }));
    store.event('a1', { type: 'error', message: 'the model refused' });
    store.event('a1', { type: 'step-end', stepId: 'implement', status: 'done' });
    expect(h.events()).toEqual(['task.started']);
    expect(h.failedTasks).toBe(0);
    expect(h.rows.get('a1')?.state).toBe('running');
  });
});

describe('check steps', () => {
  const steps = [step('typecheck', 'done', 'check'), step('unit-tests', 'failed', 'check')];

  it('prints a passed check with its duration and does not count it anywhere', () => {
    const store = new FakeStore();
    const h = harness(store);
    h.source.endRecovery();
    store.put(record({ id: 'a1', status: 'running', steps }));
    store.event('a1', { type: 'step-end', stepId: 'typecheck', status: 'done' });
    expect(h.entries.at(-1)?.event).toBe('gate.passed');
    expect(h.entries.at(-1)?.level).toBe('info');
    expect(h.failedTasks).toBe(0);
  });

  it('prints a failed check as an error with its exit code, and never counts it as a failed task', () => {
    // § 6.3: a failed check is an error line; the failed COUNT is task outcomes only.
    const store = new FakeStore();
    const h = harness(store);
    h.source.endRecovery();
    store.put(record({ id: 'a1', status: 'running', steps }));
    store.event('a1', { type: 'check-output', stepId: 'unit-tests', exitCode: 1, text: 'x' });
    store.event('a1', { type: 'step-end', stepId: 'unit-tests', status: 'failed' });
    const line = h.entries.at(-1);
    expect(line?.event).toBe('gate.failed');
    expect(line?.level).toBe('error');
    expect(line?.message).toContain('check unit-tests failed — exit 1');
    expect(h.failedTasks).toBe(0);
  });

  it('says “exit unknown” when the runner never saw a code', () => {
    const store = new FakeStore();
    const h = harness(store);
    h.source.endRecovery();
    store.put(record({ id: 'a1', status: 'running', steps }));
    store.event('a1', { type: 'check-output', stepId: 'unit-tests', exitCode: -1, text: 'spawn failed' });
    store.event('a1', { type: 'step-end', stepId: 'unit-tests', status: 'failed' });
    expect(h.entries.at(-1)?.message).toContain('exit unknown');
  });

  it('an AGENT step ending prints nothing', () => {
    const store = new FakeStore();
    const h = harness(store);
    h.source.endRecovery();
    store.put(record({ id: 'a1', status: 'running', steps: [step('implement', 'done')] }));
    store.event('a1', { type: 'step-end', stepId: 'implement', status: 'done' });
    expect(h.events()).toEqual(['task.started']);
  });
});

describe('recovery', () => {
  it('seeds what is already on disk instead of announcing it — this is the late-subscribe guard', () => {
    const store = new FakeStore();
    store.records.set('old1', record({ id: 'old1', status: 'running' }));
    store.records.set('old2', record({ id: 'old2', status: 'queued' }));
    const h = harness(store);
    expect(h.entries).toHaveLength(0);
    // …but their rows are on the table straight away, so the first redraw is honest.
    expect([...h.rows.keys()].sort()).toEqual(['old1', 'old2']);
  });

  it('does not report the transient failure a restart writes before it resumes a task', () => {
    // `RunManager.recover()` marks an interrupted run `failed` and then continues it. A naive
    // listener prints a row of failures for work that is about to carry on.
    const store = new FakeStore();
    store.records.set('old1', record({ id: 'old1', status: 'running' }));
    const h = harness(store);
    store.put(record({ id: 'old1', status: 'failed', error: 'interrupted — xezar process exited during the run' }));
    store.put(record({ id: 'old1', status: 'running' }));
    expect(h.entries).toHaveLength(0);
    expect(h.failedTasks).toBe(0);
  });

  it('announces everything normally once recovery is over', () => {
    const store = new FakeStore();
    store.records.set('old1', record({ id: 'old1', status: 'running' }));
    const h = harness(store);
    h.source.endRecovery();
    store.put(record({ id: 'old1', status: 'done', finishedAt: new Date().toISOString() }));
    expect(h.events()).toEqual(['task.done']);
  });

  it('a task created after the attach is ordinary, even during the recovery window', () => {
    const store = new FakeStore();
    store.records.set('old1', record({ id: 'old1', status: 'running' }));
    const h = harness(store);
    store.put(record({ id: 'new1', status: 'queued' }));
    expect(h.events()).toEqual(['task.queued']);
  });

  it('endRecovery is idempotent', () => {
    const store = new FakeStore();
    const h = harness(store);
    h.source.endRecovery();
    h.source.endRecovery();
    store.put(record({ id: 'a1', status: 'queued' }));
    expect(h.events()).toEqual(['task.queued']);
  });
});

describe('detach', () => {
  it('removes every listener it added, and is safe to call twice', () => {
    const store = new FakeStore();
    const h = harness(store);
    expect(store.listenerCount('run')).toBe(1);
    expect(store.listenerCount('event')).toBe(1);
    expect(store.listenerCount('deleted')).toBe(1);
    h.source.detach();
    expect(store.listenerCount('run')).toBe(0);
    expect(store.listenerCount('event')).toBe(0);
    expect(store.listenerCount('deleted')).toBe(0);
    expect(() => h.source.detach()).not.toThrow();
  });

  it('a deleted task leaves the table', () => {
    const store = new FakeStore();
    const h = harness(store);
    h.source.endRecovery();
    store.put(record({ id: 'a1', status: 'running' }));
    store.emit('deleted', 'a1');
    expect(h.rows.has('a1')).toBe(false);
  });
});

describe('untrusted text', () => {
  it('cleans a task title before it is quoted into a line', () => {
    const store = new FakeStore();
    const h = harness(store);
    h.source.endRecovery();
    store.put(
      record({ id: 'a1', status: 'queued', title: 'Fix \u001b[2J\u001b]8;;https://evil\u0007login\n10:00:00  info  fake' }),
    );
    expect(h.messages()[0]).toBe('queued — “Fix login 10:00:00 info fake”');
  });
});

function step(id: string, status: string, kind: 'agent' | 'check' = 'agent') {
  return {
    id,
    name: id,
    kind,
    status,
    iterations: 1,
    tokensUsed: 0,
    startedAt: new Date(Date.now() - 41_000).toISOString(),
    finishedAt: new Date().toISOString(),
  } as RunRecord['steps'][number];
}

it('unsanitized-step-name: every step-derived entry is single-line and escape/secret-free', () => {
  const store = new FakeStore();
  const h = harness(store);
  h.source.endRecovery();
  const hostile = 'deploy\u001b[2J\u001b]8;;https://invalid.test\u0007click\nforged AKIAIOSFODNN7EXAMPLE';
  const malicious = { ...step(hostile, 'running', 'check'), name: hostile };
  store.put(record({ id: 'a1', status: 'running', currentStepId: hostile, steps: [malicious] }));
  store.event('a1', { type: 'step-end', stepId: hostile, status: 'failed' });
  store.put(record({ id: 'a1', status: 'failed', steps: [{ ...malicious, status: 'failed' }] }));
  for (const e of h.entries) {
    const strings = [e.message, ...(e.continuation ?? []), ...(e.fields ?? []).map(([, v]) => String(v))];
    for (const text of strings) expect(text).not.toMatch(/\u001b|\n|AKIAIOSFODNN7EXAMPLE/);
  }
  expect(h.events()).toEqual(['task.started', 'gate.failed', 'task.failed']);
});
it('uses step ids in the row and started entry before currentStepId is assigned', () => {
  const store = new FakeStore();
  const h = harness(store);
  h.source.endRecovery();
  const first = { ...step('task', 'pending'), name: 'Do the task' };
  store.put(record({ id: 'a1', status: 'running', steps: [first] }));
  expect(h.messages()).toEqual(['started — task · Claude Code']);
  expect(h.entries[0]?.fields).toContainEqual(['step', 'task']);
  store.put(record({ id: 'a1', status: 'running', currentStepId: 'task', steps: [{ ...first, status: 'running' }] }));
  expect(h.rows.get('a1')?.step).toBe('task');
  expect(h.events()).toEqual(['task.started']);
});
