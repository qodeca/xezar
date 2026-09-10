import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { operationAnswerSchema, type OperationAnswer } from '@qodeca/xezar-contract';
import {
  OperationReceiptStore,
  RECEIPT_JOURNAL_FILE,
  RECEIPT_MAX_AGE_MS,
  RECEIPT_MAX_KEPT,
  RECEIPT_SNAPSHOT_EVERY_LINES,
  RECEIPT_SNAPSHOT_FILE,
  payloadDigest,
  predictRunId,
  runByKeyReconciler,
  uuidV5,
  type EffectOutcome,
  type OperationReceiptStoreOptions,
  type OperationRequest,
  type Reconciler,
} from './operation-receipts.ts';

/**
 * Issue #101 — durable operation-key idempotency (decision D-06). The four acceptance cases come
 * first; the rest pins the fail-open branches D-06 § 14 names (absent/unreachable answers must
 * read `unverified`, never `not-applied`), the damaged-journal rule, retention and degradation.
 *
 * "A task" here is a row in a tiny fake task store whose `create` IS the effect, the way
 * `RunStore.createRun` is the effect of `runs.create`. Counting its rows is what "exactly one
 * effect" means.
 */

let dataDir: string;
let now: number;
const PROJECT = 'proj-a';

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'xez-receipts-'));
  now = Date.parse('2026-09-10T12:00:00.000Z');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

/** A task store whose `create` honours a predicted id, as D-06 § 12.1 requires of `createRun`. */
function taskStore() {
  const tasks: Array<{ id: string; createdAt: string; archived?: boolean; prompt: string }> = [];
  return {
    tasks,
    create(id: string, prompt: string) {
      if (tasks.some((task) => task.id === id)) throw new Error(`duplicate id ${id}`);
      tasks.push({ id, createdAt: new Date(now).toISOString(), prompt });
    },
    getRun: (id: string) => tasks.find((task) => task.id === id),
    listRuns: () => tasks,
  };
}

function open(opts: OperationReceiptStoreOptions = {}): OperationReceiptStore {
  return OperationReceiptStore.open(dataDir, { now: () => now, ...opts });
}

/** A `runs.create`-shaped request. The payload is what zod would hand over after parsing. */
function createRequest(
  tasks: ReturnType<typeof taskStore>,
  operationId: string,
  prompt: string,
  extra: Partial<OperationRequest> = {},
): OperationRequest {
  const predictedRunId = predictRunId(PROJECT, operationId);
  return {
    projectId: PROJECT,
    operationId,
    action: 'runs.create',
    payload: { prompt, workflow: 'quick-task' },
    reconcile: { kind: 'run-by-key', predictedRunId },
    effect: (): EffectOutcome => {
      tasks.create(predictedRunId, prompt);
      return { outcome: 'ok', resultRef: { kind: 'run', id: predictedRunId } };
    },
    ...extra,
  };
}

/** Every answer must be exactly a contract shape — the wire and the store cannot drift. */
function wire(answer: OperationAnswer): OperationAnswer {
  return operationAnswerSchema.parse(answer);
}

function journalLines(): unknown[] {
  return readFileSync(join(dataDir, RECEIPT_JOURNAL_FILE), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

describe('acceptance (#101)', () => {
  it('(1) a dropped response retried under the same key returns the original result and creates exactly one task', async () => {
    const tasks = taskStore();
    const store = open();
    const first = wire(await store.execute(createRequest(tasks, 'op-00000001', 'fix the bug')));
    expect(first).toMatchObject({ status: 'ok', replayed: false });
    // The response is "dropped": the leader never saw `first` and retries the very same call.
    const retry = wire(await store.execute(createRequest(tasks, 'op-00000001', 'fix the bug')));
    expect(tasks.tasks).toHaveLength(1);
    expect(retry).toMatchObject({ status: 'ok', replayed: true });
    expect('resultRef' in retry && retry.resultRef).toEqual('resultRef' in first && first.resultRef);

    // …and the same across a restart: the receipt is durable, not a per-process cache.
    const restarted = open();
    const afterRestart = wire(await restarted.execute(createRequest(tasks, 'op-00000001', 'fix the bug')));
    expect(tasks.tasks).toHaveLength(1);
    expect(afterRestart).toEqual(retry);
  });

  it('(2) an intentionally new key on byte-identical work creates a second task', async () => {
    const tasks = taskStore();
    const store = open();
    const a = wire(await store.execute(createRequest(tasks, 'op-00000001', 'fix the bug')));
    const b = wire(await store.execute(createRequest(tasks, 'op-00000002', 'fix the bug')));
    expect(tasks.tasks).toHaveLength(2);
    expect(a).toMatchObject({ status: 'ok', replayed: false });
    expect(b).toMatchObject({ status: 'ok', replayed: false });
    expect(tasks.tasks[0]!.id).not.toBe(tasks.tasks[1]!.id);
  });

  it('(3) the same key with a conflicting payload is refused explicitly and returns no stored result', async () => {
    const tasks = taskStore();
    const store = open();
    await store.execute(createRequest(tasks, 'op-00000001', 'fix the bug'));
    const conflict = wire(await store.execute(createRequest(tasks, 'op-00000001', 'delete the repo')));
    expect(tasks.tasks).toHaveLength(1);
    expect(conflict).toEqual({
      error: 'operation_key_conflict',
      operationId: 'op-00000001',
      storedAction: 'runs.create',
      storedAt: new Date(now).toISOString(),
      mismatch: 'payload',
    });
    expect(JSON.stringify(conflict)).not.toContain(tasks.tasks[0]!.id);

    const otherAction = wire(
      await store.execute({ ...createRequest(tasks, 'op-00000001', 'fix the bug'), action: 'runs.archive' }),
    );
    expect(otherAction).toMatchObject({ error: 'operation_key_conflict', mismatch: 'action' });
    expect(tasks.tasks).toHaveLength(1);
  });

  it('(4) a crash between the effect and its receipt yields unverified, never a blind repeat', async () => {
    const tasks = taskStore();
    const crashed = open();
    // The effect happens, then the process "dies" before the settled line: the promise never
    // settles, and a fresh store opens the same directory as the restarted process would.
    let effectRan = 0;
    void crashed.execute(
      createRequest(tasks, 'op-00000001', 'fix the bug', {
        effect: () => {
          effectRan += 1;
          tasks.create(predictRunId(PROJECT, 'op-00000001'), 'fix the bug');
          return new Promise<EffectOutcome>(() => {});
        },
      }),
    );
    expect(effectRan).toBe(1);

    // No reconciler can answer (think: an external system that is unreachable).
    const restarted = open();
    const retry = wire(
      await restarted.execute(
        createRequest(tasks, 'op-00000001', 'fix the bug', {
          effect: () => {
            effectRan += 1;
            throw new Error('must not run');
          },
        }),
      ),
    );
    expect(effectRan).toBe(1);
    expect(tasks.tasks).toHaveLength(1);
    expect(retry).toMatchObject({
      status: 'unverified',
      operationId: 'op-00000001',
      action: 'runs.create',
      reconcile: { kind: 'run-by-key', reason: 'no reconciler' },
      guidance: 'read current state; a new operationId is a new action',
    });

    // Once a reader CAN answer, the retry settles to the original result — still no second task.
    const reconciled = open({ reconcilers: { 'run-by-key': runByKeyReconciler(tasks) } });
    const settled = wire(await reconciled.execute(createRequest(tasks, 'op-00000001', 'fix the bug')));
    expect(settled).toMatchObject({
      status: 'ok',
      replayed: true,
      resultRef: { kind: 'run', id: predictRunId(PROJECT, 'op-00000001') },
    });
    expect(tasks.tasks).toHaveLength(1);
  });

  it('(4) survives a real SIGKILL between the effect and the settled line', async () => {
    // A child process opens the store, writes the intent, performs the effect (a marker file),
    // signals readiness and hangs before settling. Killed by its SAVED PID, never by pattern.
    const source = new URL('./operation-receipts.ts', import.meta.url).href;
    const marker = join(dataDir, 'effect-marker');
    const script = `
      import { OperationReceiptStore } from ${JSON.stringify(source)};
      import { appendFileSync } from 'node:fs';
      const store = OperationReceiptStore.open(process.argv[1]);
      void store.execute({
        projectId: 'proj-a', operationId: 'op-crash-01', action: 'runs.create',
        payload: { prompt: 'x' }, reconcile: { kind: 'none' },
        effect: () => { appendFileSync(process.argv[2], 'effect\\n'); console.log('EFFECT'); return new Promise(() => {}); },
      });
      setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dataDir, marker], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let out = '';
        let err = '';
        child.stdout!.on('data', (chunk: Buffer) => {
          out += chunk.toString();
          if (out.includes('EFFECT')) resolve();
        });
        child.stderr!.on('data', (chunk: Buffer) => (err += chunk.toString()));
        child.on('exit', (code) => reject(new Error(`child exited early (${code}): ${err}`)));
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const ended = once(child, 'exit');
        child.kill('SIGKILL');
        await ended;
      }
    }

    let ran = 0;
    const answer = wire(
      await open().execute({
        projectId: 'proj-a',
        operationId: 'op-crash-01',
        action: 'runs.create',
        payload: { prompt: 'x' },
        reconcile: { kind: 'none' },
        effect: () => {
          ran += 1;
          return { outcome: 'ok', resultRef: { kind: 'run', id: 'second' } };
        },
      }),
    );
    expect(ran).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('effect\n');
    expect(answer).toMatchObject({ status: 'unverified', operationId: 'op-crash-01' });
  }, 30_000);
});

describe('the § 6 lookup', () => {
  it('answers in-progress to a duplicate that arrives while the first attempt is still live', async () => {
    const tasks = taskStore();
    const store = open();
    let release!: () => void;
    let calls = 0;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const request = createRequest(tasks, 'op-00000001', 'fix the bug', {
      effect: async (): Promise<EffectOutcome> => {
        calls += 1;
        await gate;
        return { outcome: 'ok', resultRef: { kind: 'run', id: 'r1' } };
      },
    });
    const first = store.execute(request);
    const duplicate = wire(await store.execute(request));
    expect(duplicate).toMatchObject({ status: 'in-progress', operationId: 'op-00000001', action: 'runs.create' });
    release();
    expect(wire(await first)).toMatchObject({ status: 'ok', replayed: false });
    expect(calls).toBe(1);
  });

  it('keeps projects in separate namespaces — one id in two projects is two operations', async () => {
    const tasks = taskStore();
    const store = open();
    await store.execute(createRequest(tasks, 'op-00000001', 'fix the bug'));
    const predictedB = predictRunId('proj-b', 'op-00000001');
    const other = wire(
      await store.execute({
        ...createRequest(tasks, 'op-00000001', 'something else'),
        projectId: 'proj-b',
        reconcile: { kind: 'run-by-key', predictedRunId: predictedB },
        effect: () => {
          tasks.create(predictedB, 'something else');
          return { outcome: 'ok', resultRef: { kind: 'run', id: predictedB } };
        },
      }),
    );
    expect(other).toMatchObject({ status: 'ok', replayed: false });
    expect(tasks.tasks).toHaveLength(2);
  });

  it('a precheck refusal writes no intent, and a retry replays the rejection without re-checking', async () => {
    const tasks = taskStore();
    const store = open();
    const precheck = vi.fn(() => 'stale_version');
    const effect = vi.fn((): EffectOutcome => ({ outcome: 'ok', resultRef: { kind: 'run', id: 'x' } }));
    const request = createRequest(tasks, 'op-00000001', 'fix the bug', { precheck, effect });
    expect(wire(await store.execute(request))).toMatchObject({ status: 'rejected', errorCode: 'stale_version', replayed: false });
    expect(wire(await store.execute(request))).toMatchObject({ status: 'rejected', errorCode: 'stale_version', replayed: true });
    expect(precheck).toHaveBeenCalledTimes(1);
    expect(effect).not.toHaveBeenCalled();
    const phases = journalLines().flatMap((line) => ('phase' in (line as object) ? [(line as { phase: string }).phase] : []));
    expect(phases).toEqual(['settled']);
  });

  it('an effect that throws is reconciled, not repeated', async () => {
    const tasks = taskStore();
    const store = open();
    const effect = vi.fn((): EffectOutcome => {
      throw new Error('socket hang up with token ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    });
    const request = createRequest(tasks, 'op-00000001', 'fix the bug', { effect });
    const answer = wire(await store.execute(request));
    expect(answer).toMatchObject({ status: 'unverified', reconcile: { reason: 'no reconciler' } });
    expect(JSON.stringify(answer)).not.toContain('ghp_');
    expect(wire(await store.execute(request))).toMatchObject({ status: 'unverified' });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('refuses the mutation before its effect when the journal cannot be written', async () => {
    const blocker = join(dataDir, 'not-a-directory');
    writeFileSync(blocker, 'x');
    const store = OperationReceiptStore.open(join(blocker, 'xezar'));
    const effect = vi.fn((): EffectOutcome => ({ outcome: 'ok', resultRef: { kind: 'run', id: 'x' } }));
    const answer = wire(
      await store.execute({ projectId: PROJECT, operationId: 'op-00000001', action: 'a', payload: {}, reconcile: { kind: 'none' }, effect }),
    );
    expect(answer).toEqual({ error: 'operation_receipt_unavailable', operationId: 'op-00000001', reason: 'journal_unwritable' });
    expect(effect).not.toHaveBeenCalled();
  });

  it('rejects an operation id outside the contract shape instead of keying on it', async () => {
    const store = open();
    const request = { projectId: PROJECT, action: 'a', payload: {}, reconcile: { kind: 'none' as const }, effect: () => ({ outcome: 'ok' as const, resultRef: { kind: 'run', id: 'x' } }) };
    await expect(store.execute({ ...request, operationId: 'short' })).rejects.toThrow();
    await expect(store.execute({ ...request, operationId: 'a/b/c/d/e/f' })).rejects.toThrow();
  });
});

describe('reconciliation (D-06 § 9.3)', () => {
  async function dangling(store: OperationReceiptStore, request: OperationRequest): Promise<void> {
    void store.execute({ ...request, effect: () => new Promise<EffectOutcome>(() => {}) });
    await Promise.resolve();
  }

  it('an unreachable external system stays unverified — never not-applied — and a raw error body never reaches the wire', async () => {
    const forge: Reconciler = () => {
      throw new Error('gh: HTTP 401 Bad credentials (token ghp_secret0000000000000000000000000000)');
    };
    const request: OperationRequest = {
      projectId: PROJECT,
      operationId: 'op-pr-00001',
      action: 'pr.create',
      payload: { branch: 'xez/abc' },
      reconcile: { kind: 'forge-search', repository: 'qodeca/xezar', headBranch: 'xez/abc' },
      effect: () => ({ outcome: 'ok', resultRef: { kind: 'pr', id: '1' } }),
    };
    await dangling(open(), request);
    const answer = wire(await open({ reconcilers: { 'forge-search': forge } }).execute(request));
    expect(answer).toMatchObject({ status: 'unverified', reconcile: { kind: 'forge-search', reason: 'reconciler_failed' } });
    expect(JSON.stringify(answer)).not.toContain('ghp_');

    // A reconciler that answers in prose is sanitised to a fixed code too.
    const chatty: Reconciler = () => ({ verdict: 'unverified', reason: 'error: token=ghp_x /Users/me/repo' });
    const second = wire(await open({ reconcilers: { 'forge-search': chatty } }).execute(request));
    expect(second).toMatchObject({ status: 'unverified', reconcile: { reason: 'reconciler_failed' } });
  });

  it('a positive not-applied settles the dangling intent, and every retry replays that answer', async () => {
    const request: OperationRequest = {
      projectId: PROJECT,
      operationId: 'op-git-00001',
      action: 'git.push',
      payload: { ref: 'refs/heads/x' },
      reconcile: { kind: 'git-state', ref: 'refs/heads/x', sha: 'abc' },
      effect: () => ({ outcome: 'ok', resultRef: { kind: 'ref', id: 'x' } }),
    };
    await dangling(open(), request);
    const reconciled = open({ reconcilers: { 'git-state': () => ({ verdict: 'not-applied' }) } });
    expect(wire(await reconciled.execute(request))).toMatchObject({ status: 'not-applied', replayed: true });
    // Without any reconciler now, the settled answer is still what comes back.
    expect(wire(await open().execute(request))).toMatchObject({ status: 'not-applied', replayed: true });
  });

  it('reconcilePending settles dangling intents in the background', async () => {
    const tasks = taskStore();
    const request = createRequest(tasks, 'op-00000001', 'fix the bug');
    await dangling(open(), { ...request });
    tasks.create(predictRunId(PROJECT, 'op-00000001'), 'fix the bug');
    const store = open({ reconcilers: { 'run-by-key': runByKeyReconciler(tasks) } });
    await store.reconcilePending();
    const reopened = open();
    expect(wire(await reopened.execute(request))).toMatchObject({ status: 'ok', replayed: true });
    expect(tasks.tasks).toHaveLength(1);
  });

  describe('run-by-key', () => {
    const startedAt = '2026-09-10T12:00:00.000Z';
    const predicate = { kind: 'run-by-key' as const, predictedRunId: predictRunId(PROJECT, 'op-00000001') };
    const index = (runs: Array<{ id: string; createdAt: string; archived?: boolean }>) => ({
      getRun: (id: string) => runs.find((run) => run.id === id),
      listRuns: () => runs,
    });

    it('finds the run under its predicted id', () => {
      const verdict = runByKeyReconciler(index([{ id: predicate.predictedRunId, createdAt: startedAt }]))(predicate, { action: 'runs.create', startedAt });
      expect(verdict).toEqual({ verdict: 'ok', resultRef: { kind: 'run', id: predicate.predictedRunId } });
    });

    it('answers not-applied only while the index still reaches back past the intent', () => {
      const verdict = runByKeyReconciler(index([{ id: 'older', createdAt: '2026-09-09T00:00:00.000Z' }]))(predicate, { action: 'runs.create', startedAt });
      expect(verdict).toEqual({ verdict: 'not-applied' });
    });

    it('a run pruned out of the index is unverified, not not-applied', () => {
      // Count-based pruning removed everything older than this: the store can no longer tell.
      const verdict = runByKeyReconciler(index([{ id: 'newer', createdAt: '2026-09-11T00:00:00.000Z' }]))(predicate, { action: 'runs.create', startedAt });
      expect(verdict).toEqual({ verdict: 'unverified', reason: 'run index pruned' });
    });

    it('takes the newest of the two pools, since archived and live runs are pruned separately', () => {
      const runs = [
        { id: 'ancient-archived', createdAt: '2026-01-01T00:00:00.000Z', archived: true },
        { id: 'live-after-pruning', createdAt: '2026-09-11T00:00:00.000Z' },
      ];
      expect(runByKeyReconciler(index(runs))(predicate, { action: 'runs.create', startedAt })).toMatchObject({ verdict: 'unverified' });
    });

    it('an empty index cannot answer at all', () => {
      expect(runByKeyReconciler(index([]))(predicate, { action: 'runs.create', startedAt })).toMatchObject({ verdict: 'unverified' });
    });
  });
});

describe('journal damage (D-06 § 7.4)', () => {
  it('a torn final line quarantines, and a key miss then does NOT execute when nothing can answer', async () => {
    const tasks = taskStore();
    await open().execute(createRequest(tasks, 'op-00000001', 'first'));
    // The crash artefact: half of an intent line for another operation, no trailing newline.
    appendFileSync(join(dataDir, RECEIPT_JOURNAL_FILE), '{"v":1,"key":"proj-a/op-00000002","action":"runs.cr');

    const store = open();
    expect(store.stats().quarantined).toBe(1);
    const effect = vi.fn((): EffectOutcome => ({ outcome: 'ok', resultRef: { kind: 'run', id: 'dup' } }));
    const answer = wire(await store.execute({ ...createRequest(tasks, 'op-00000002', 'second'), effect }));
    expect(answer).toMatchObject({ status: 'unverified', reconcile: { reason: 'journal_damaged' } });
    expect(effect).not.toHaveBeenCalled();
    // The good receipt before the tear is intact.
    expect(wire(await store.execute(createRequest(tasks, 'op-00000001', 'first')))).toMatchObject({ status: 'ok', replayed: true });
  });

  it('with a damaged journal, a reconciler that proves not-applied lets the miss execute exactly once', async () => {
    const tasks = taskStore();
    tasks.create('seed', 'an older run');
    now += 1_000;
    writeFileSync(join(dataDir, RECEIPT_JOURNAL_FILE), 'garbage that is not json\n');
    const store = open({ reconcilers: { 'run-by-key': runByKeyReconciler(tasks) } });
    const answer = wire(await store.execute(createRequest(tasks, 'op-00000002', 'second')));
    expect(answer).toMatchObject({ status: 'ok', replayed: false });
    expect(tasks.tasks).toHaveLength(2);
  });

  it('with a damaged journal, a reconciler that finds the run replays instead of duplicating', async () => {
    const tasks = taskStore();
    tasks.create(predictRunId(PROJECT, 'op-00000002'), 'second');
    writeFileSync(join(dataDir, RECEIPT_JOURNAL_FILE), '{"torn\n');
    const store = open({ reconcilers: { 'run-by-key': runByKeyReconciler(tasks) } });
    const answer = wire(await store.execute(createRequest(tasks, 'op-00000002', 'second')));
    expect(answer).toMatchObject({ status: 'ok', replayed: true });
    expect(tasks.tasks).toHaveLength(1);
  });

  it('appending after a torn line keeps the new receipt readable', async () => {
    const tasks = taskStore();
    writeFileSync(join(dataDir, RECEIPT_JOURNAL_FILE), '{"torn');
    const store = open({ reconcilers: { 'run-by-key': () => ({ verdict: 'not-applied' }) } });
    await store.execute(createRequest(tasks, 'op-00000003', 'third'));
    const reopened = open();
    expect(reopened.stats()).toMatchObject({ receipts: 1, quarantined: 1 });
    expect(wire(await reopened.execute(createRequest(tasks, 'op-00000003', 'third')))).toMatchObject({ status: 'ok', replayed: true });
  });

  it('the quarantine survives compaction until the age floor has passed, then clears on its own', async () => {
    const tasks = taskStore();
    writeFileSync(join(dataDir, RECEIPT_JOURNAL_FILE), 'not json\n');
    const store = open({ reconcilers: { 'run-by-key': () => ({ verdict: 'not-applied' }) } });
    await store.execute(createRequest(tasks, 'op-00000001', 'x'));
    store.close();
    expect(open().stats().quarantined).toBe(1);
    now += RECEIPT_MAX_AGE_MS + 1;
    open().close();
    expect(open().stats().quarantined).toBe(0);
  });
});

describe('degradation — written, never required', () => {
  it('deleting both files leaves a fresh, working store', async () => {
    const tasks = taskStore();
    await open().execute(createRequest(tasks, 'op-00000001', 'x'));
    open().close();
    rmSync(join(dataDir, RECEIPT_JOURNAL_FILE));
    rmSync(join(dataDir, RECEIPT_SNAPSHOT_FILE));
    const store = open();
    expect(store.stats()).toEqual({ receipts: 0, quarantined: 0, live: 0 });
    expect(wire(await store.execute(createRequest(tasks, 'op-00000009', 'y')))).toMatchObject({ status: 'ok' });
  });

  it('a directory that does not exist yet is an empty store, created on first write', async () => {
    const nested = join(dataDir, 'does', 'not', 'exist');
    const store = OperationReceiptStore.open(nested);
    expect(store.stats().receipts).toBe(0);
    await store.execute({ projectId: PROJECT, operationId: 'op-00000001', action: 'a', payload: {}, reconcile: { kind: 'none' }, effect: () => ({ outcome: 'ok', resultRef: { kind: 'x', id: '1' } }) });
    expect(existsSync(join(nested, RECEIPT_JOURNAL_FILE))).toBe(true);
  });

  it('a corrupt snapshot is ignored and the journal is read in full', async () => {
    const tasks = taskStore();
    await open().execute(createRequest(tasks, 'op-00000001', 'x'));
    open().close();
    writeFileSync(join(dataDir, RECEIPT_SNAPSHOT_FILE), '{ nope');
    const store = open();
    expect(store.stats()).toMatchObject({ receipts: 1, quarantined: 0 });
  });

  it('a snapshot from another journal generation is never trusted', async () => {
    const tasks = taskStore();
    await open().execute(createRequest(tasks, 'op-00000001', 'x'));
    open().close();
    const snapshot = readFileSync(join(dataDir, RECEIPT_SNAPSHOT_FILE), 'utf8');
    // A new journal replaces the old one; the stale snapshot must not resurrect op-1.
    rmSync(join(dataDir, RECEIPT_JOURNAL_FILE));
    await open().execute(createRequest(tasks, 'op-00000002', 'y'));
    writeFileSync(join(dataDir, RECEIPT_SNAPSHOT_FILE), snapshot);
    const store = open();
    expect(store.stats().receipts).toBe(1);
    expect(wire(await store.execute(createRequest(tasks, 'op-00000002', 'y')))).toMatchObject({ replayed: true });
  });

  it('a receipt line from a newer format version is quarantined, not guessed at; unknown keys survive compaction', async () => {
    const tasks = taskStore();
    await open().execute(createRequest(tasks, 'op-00000001', 'x'));
    const lines = journalLines() as Array<Record<string, unknown>>;
    const settled = lines.find((line) => line.phase === 'settled')!;
    appendFileSync(join(dataDir, RECEIPT_JOURNAL_FILE), `${JSON.stringify({ ...settled, key: 'proj-a/op-00000002', v: 2 })}\n`);
    appendFileSync(join(dataDir, RECEIPT_JOURNAL_FILE), `${JSON.stringify({ ...settled, key: 'proj-a/op-00000003', futureField: 7 })}\n`);
    const store = open();
    expect(store.stats()).toMatchObject({ receipts: 2, quarantined: 1 });
    store.close();
    expect(readFileSync(join(dataDir, RECEIPT_JOURNAL_FILE), 'utf8')).toContain('"futureField":7');
  });
});

describe('storage (D-06 § 7)', () => {
  it('writes intent before the effect and settled after it, synchronously', async () => {
    const tasks = taskStore();
    const store = open();
    let seenAtEffect: unknown[] = [];
    await store.execute(
      createRequest(tasks, 'op-00000001', 'x', {
        effect: () => {
          seenAtEffect = journalLines();
          return { outcome: 'ok', resultRef: { kind: 'run', id: 'r' } };
        },
      }),
    );
    expect(seenAtEffect.at(-1)).toMatchObject({ phase: 'intent', key: 'proj-a/op-00000001', reconcile: { kind: 'run-by-key' } });
    expect(journalLines().at(-1)).toMatchObject({ phase: 'settled', outcome: 'ok', resultRef: { kind: 'run', id: 'r' } });
  });

  it('never persists the payload itself — only its digest', async () => {
    const tasks = taskStore();
    await open().execute(createRequest(tasks, 'op-00000001', 'a very private prompt'));
    expect(readFileSync(join(dataDir, RECEIPT_JOURNAL_FILE), 'utf8')).not.toContain('private prompt');
  });

  it('compacts into an offset-anchored snapshot every N lines, and a reopen folds the tail on top', async () => {
    const tasks = taskStore();
    const store = open({ snapshotEveryLines: 4 });
    for (let i = 1; i <= 3; i++) await store.execute(createRequest(tasks, `op-0000000${i}`, `t${i}`));
    const snapshot = z.object({ offset: z.number(), receipts: z.array(z.unknown()) }).parse(
      JSON.parse(readFileSync(join(dataDir, RECEIPT_SNAPSHOT_FILE), 'utf8')),
    );
    expect(snapshot.receipts).toHaveLength(2);
    const reopened = open();
    expect(reopened.stats().receipts).toBe(3);
    expect(wire(await reopened.execute(createRequest(tasks, 'op-00000003', 't3')))).toMatchObject({ replayed: true });
  });

  it('snapshot files are private to the user', async () => {
    const tasks = taskStore();
    await open().execute(createRequest(tasks, 'op-00000001', 'x'));
    open().close();
    const { statSync } = await import('node:fs');
    if (process.platform !== 'win32') {
      expect(statSync(join(dataDir, RECEIPT_JOURNAL_FILE)).mode & 0o777).toBe(0o600);
      expect(statSync(join(dataDir, RECEIPT_SNAPSHOT_FILE)).mode & 0o777).toBe(0o600);
    }
  });
});

describe('retention (D-06 § 8)', () => {
  const HOUR = 60 * 60_000;

  async function fill(store: OperationReceiptStore, tasks: ReturnType<typeof taskStore>, count: number, prefix: string) {
    for (let i = 0; i < count; i++) {
      await store.execute({ ...createRequest(tasks, `${prefix}-${String(i).padStart(6, '0')}`, `${prefix}${i}`), reconcile: { kind: 'none' } });
      now += 1_000;
    }
  }

  it('uses the decided bounds: 84 h and 50 000 receipts, compacted every 1 000 lines', () => {
    expect(RECEIPT_MAX_AGE_MS).toBe(84 * HOUR);
    expect(RECEIPT_MAX_KEPT).toBe(50_000);
    expect(RECEIPT_SNAPSHOT_EVERY_LINES).toBe(1_000);
  });

  it('evicts only receipts that are BOTH older than the floor AND outside the newest N', async () => {
    const tasks = taskStore();
    const store = open({ maxKept: 3, maxAgeMs: 10 * HOUR });
    await fill(store, tasks, 4, 'old');
    now += 11 * HOUR;
    await fill(store, tasks, 2, 'young');
    store.close();
    // Six receipts, keep 3 newest: young-0, young-1, old-3. Of the other three, all old → evicted.
    expect(open().stats().receipts).toBe(3);

    // Within the count bound nothing is evicted, however old.
    now += 1_000 * HOUR;
    open({ maxKept: 3, maxAgeMs: 10 * HOUR }).close();
    expect(open().stats().receipts).toBe(3);
  });

  it('never evicts a young receipt, even far past the count bound', async () => {
    const tasks = taskStore();
    const store = open({ maxKept: 2, maxAgeMs: 10 * HOUR });
    await fill(store, tasks, 6, 'op');
    store.close();
    expect(open().stats().receipts).toBe(6);
  });

  it('never evicts a receipt while the run it names is still in the index (§ 8.4)', async () => {
    const tasks = taskStore();
    const store = open({ maxKept: 1, maxAgeMs: HOUR });
    await store.execute(createRequest(tasks, 'op-00000001', 'kept'));
    now += 1_000;
    await store.execute(createRequest(tasks, 'op-00000002', 'pruned'));
    now += 10 * HOUR;
    tasks.tasks.splice(1, 1); // the run store pruned op-2's run; op-1's run is still indexed
    await store.execute({ ...createRequest(tasks, 'op-00000003', 'new'), reconcile: { kind: 'none' } });
    const live = (ref: { kind: string; id: string }) => ref.kind === 'run' && tasks.tasks.some((t) => t.id === ref.id);
    const compacting = open({ maxKept: 1, maxAgeMs: HOUR, isResultLive: live });
    compacting.close();
    const reopened = open();
    expect(reopened.stats().receipts).toBe(2);
    expect(wire(await reopened.execute(createRequest(tasks, 'op-00000001', 'kept')))).toMatchObject({ replayed: true });
  });

  it('never evicts a dangling intent — its unverified answer must not decay into a miss', async () => {
    const tasks = taskStore();
    const store = open({ maxKept: 1, maxAgeMs: HOUR });
    void store.execute({ ...createRequest(tasks, 'op-00000001', 'x'), effect: () => new Promise<EffectOutcome>(() => {}) });
    now += 10 * HOUR;
    const later = open({ maxKept: 1, maxAgeMs: HOUR });
    await later.execute({ ...createRequest(tasks, 'op-00000002', 'y'), reconcile: { kind: 'none' } });
    later.close();
    expect(wire(await open().execute(createRequest(tasks, 'op-00000001', 'x')))).toMatchObject({ status: 'unverified' });
  });
});

describe('payload digest (D-06 § 5.4)', () => {
  it('is independent of key order and whitespace — it digests the parsed value, not the text', () => {
    const a = JSON.parse('{"prompt":"x","opts":{"b":1,"a":2}}') as unknown;
    const b = JSON.parse('{ "opts": { "a": 2, "b": 1 },\n  "prompt": "x" }') as unknown;
    expect(payloadDigest(a)).toBe(payloadDigest(b));
    expect(payloadDigest(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the zod-parsed payload is what counts: stripped unknown keys and filled defaults collapse', () => {
    const schema = z.object({ prompt: z.string(), workflow: z.string().default('quick-task') });
    const a = schema.parse({ prompt: 'x', junk: 1 });
    const b = schema.parse({ prompt: 'x', workflow: 'quick-task' });
    expect(payloadDigest(a)).toBe(payloadDigest(b));
    expect(payloadDigest({ prompt: 'x' })).not.toBe(payloadDigest({ prompt: 'y' }));
  });

  it('digests attachment BYTES, never where they came from', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(payloadDigest({ image: bytes })).toBe(payloadDigest({ image: new Uint8Array([1, 2, 3]) }));
    expect(payloadDigest({ image: bytes })).not.toBe(payloadDigest({ image: new Uint8Array([1, 2, 4]) }));
  });

  it('honours digestExclude and drops undefined keys, but refuses what JSON cannot carry', () => {
    expect(payloadDigest({ a: 1, server: 'x' }, ['server'])).toBe(payloadDigest({ a: 1 }));
    expect(payloadDigest({ a: 1, b: undefined })).toBe(payloadDigest({ a: 1 }));
    expect(() => payloadDigest({ a: Number.NaN })).toThrow();
    expect(() => payloadDigest({ a: new Map() })).toThrow();
  });
});

describe('predicted run ids (D-06 § 12.1)', () => {
  it('uuidV5 matches the RFC 4122 reference vector', () => {
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('is stable per operation key and differs across operations and projects', () => {
    expect(predictRunId('p', 'op-00000001')).toBe(predictRunId('p', 'op-00000001'));
    expect(predictRunId('p', 'op-00000001')).not.toBe(predictRunId('p', 'op-00000002'));
    expect(predictRunId('p', 'op-00000001')).not.toBe(predictRunId('q', 'op-00000001'));
    expect(z.uuid().safeParse(predictRunId('p', 'op-00000001')).success).toBe(true);
  });
});
