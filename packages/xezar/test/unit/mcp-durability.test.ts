import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  MCP_JOURNAL_MIN_RETENTION_DAYS,
  MCP_JOURNAL_PAGE_BYTES,
  MCP_JOURNAL_PAGE_ROWS,
  MCP_JOURNAL_RETAINED_ROWS,
  MCP_STALE_VERSION_GUIDANCE,
  UNVERIFIED_GUIDANCE,
  type McpJournalAppendInput,
  type McpJournalRow,
  type OperationAnswer,
} from '@qodeca/xezar-contract';

import { AuditTrail, auditTrailPath } from '../../src/mcp/audit-trail.ts';
import { EventController, type EventDispatch } from '../../src/mcp/event-controller.ts';
import { EventJournal } from '../../src/mcp/event-journal.ts';
import { OperationReceiptStore, RECEIPT_JOURNAL_FILE, RECEIPT_SNAPSHOT_FILE, type EffectOutcome } from '../../src/mcp/operation-receipts.ts';
import { LEADER_CURSORS_FILE, LeaderCursors, LeaderInbox, reactionOperationId, reconnect, runStateReader } from '../../src/mcp/reconnect.ts';
import { guardedRunMutation, runVersion } from '../../src/mcp/stale-write.ts';
import { RunStore } from '../../src/runs/store.ts';
import { ProjectOwnership } from '../../src/workspace/project-owner.ts';

/**
 * #117 — the correctness and durability acceptance cases (A-13, A-14, A-16, A-21) at the level of
 * the project's own stores: no server, no browser, no socket. The whole-feature half — the same
 * guarantees reached through the cockpit door and the MCP socket of the shared A/B world — is
 * `src/mcp/acceptance-durability.test.ts`; the packed-CLI upgrade half of A-16 is
 * `test/e2e/mcp-upgrade.test.ts`.
 *
 * Every case runs on the real `RunStore`, the real #101 receipts, the real #103 journal, the real
 * #105 reconnect and the real D-02 owner slot. Nothing here is a stub of the thing under test.
 */

const PROJECT = 'alpha-proj';
const DAY_MS = 24 * 60 * 60 * 1_000;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'xez-117-'));
}

/** Every file under `dir` by relative path, size and SHA-256 of its bytes: the "byte-identical" bar. */
function treeDigest(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const info = lstatSync(path);
      if (info.isDirectory()) walk(path);
      else out.push(`${path.slice(dir.length)} ${info.size} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
    }
  };
  walk(dir);
  return out;
}

function queuedTask(store: RunStore, task = 'the brief the leader read'): string {
  const run = store.createRun({ title: 'durability task', workflow: 'quick-task', task, steps: [] });
  store.updateRun(run.id, { status: 'queued' });
  store.flush();
  return run.id;
}

/** Collect console.warn for the life of `fn` — the stores that do not take a `warn` seam use it. */
async function capturingWarn<T>(fn: () => T | Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
  try {
    return { value: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

function terminalRow(runId: string, version: string | null, summary = 'task reached a terminal status'): McpJournalAppendInput {
  return { category: 'E-01', kind: 'task.terminal', subject: { type: 'run', id: runId, version }, origin: 'system', causedBy: null, summary };
}

/** A receipt answer's status, or its error code for the one answer that has no status. */
const statusOf = (answer: OperationAnswer): string => ('status' in answer ? answer.status : answer.error);

function asUnverified(answer: OperationAnswer): Extract<OperationAnswer, { status: 'unverified' }> {
  assert.equal(statusOf(answer), 'unverified', `expected an explicit unverified answer, got ${JSON.stringify(answer)}`);
  return answer as Extract<OperationAnswer, { status: 'unverified' }>;
}

// ---- A-13 ----------------------------------------------------------------------------------------

describe('A-13 — a stale leader mutation after a human change (N-03)', () => {
  test('is rejected with nothing applied, the human state stays byte-identical, and only a fresh read decides again', () => {
    const dir = tempDir();
    try {
      const store = RunStore.open(dir);
      const id = queuedTask(store);
      const leaderRead = runVersion(store, id);
      assert.ok(leaderRead, 'the leader read a version');

      // The human edits the queued brief — the same store call the cockpit's PATCH /runs/:id makes.
      store.updateRun(id, { task: 'the brief the HUMAN wrote' });
      store.flush();
      const bytesBefore = treeDigest(dir);
      const recordBefore = JSON.stringify(store.getRun(id));

      let effects = 0;
      const stale = guardedRunMutation(store, id, leaderRead, () => {
        effects += 1;
        return store.updateRun(id, { task: 'the brief the LEADER wanted' });
      });
      store.flush();

      assert.equal(stale.status, 'conflict');
      assert.ok(stale.status === 'conflict');
      assert.equal(stale.applied, false);
      assert.equal(stale.error, 'stale_version');
      assert.equal(stale.changedSince, true);
      assert.equal(stale.guidance, MCP_STALE_VERSION_GUIDANCE);
      assert.equal(stale.currentVersion, runVersion(store, id), 'the rejection hands back the CURRENT version to re-read against');
      assert.notEqual(stale.currentVersion, leaderRead);
      assert.equal(effects, 0, 'the effect never ran');
      assert.equal(JSON.stringify(store.getRun(id)), recordBefore, "the human's record is unchanged in memory");
      assert.deepEqual(treeDigest(dir), bytesBefore, "the human's state is byte-identical on disk");

      // No silent reconciliation: the stale token stays stale, whatever is retried with it.
      const again = guardedRunMutation(store, id, leaderRead, () => {
        effects += 1;
      });
      assert.equal(again.status, 'conflict');
      assert.equal(effects, 0);

      // The leader decides again only after a fresh read.
      const fresh = runVersion(store, id);
      const decided = guardedRunMutation(store, id, fresh, () => {
        effects += 1;
        return store.updateRun(id, { task: 'the leader, after reading the human brief' });
      });
      assert.equal(decided.status, 'done');
      assert.equal(effects, 1);
      assert.equal(store.getRun(id)?.task, 'the leader, after reading the human brief');
      store.flush();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('concurrent calls on one read: exactly one applies, the others are refused with nothing applied', async () => {
    const dir = tempDir();
    try {
      const store = RunStore.open(dir);
      const id = queuedTask(store);
      const read = runVersion(store, id);
      let effects = 0;
      const attempt = (n: number) => async () => {
        // Each call yields first, as a real tool call does between its read and its write.
        await new Promise<void>((done) => setImmediate(done));
        return guardedRunMutation(store, id, read, () => {
          effects += 1;
          return store.updateRun(id, { title: `leader call ${n}` });
        });
      };
      const results = await Promise.all(Array.from({ length: 8 }, (_, n) => attempt(n)()));
      const done = results.flatMap((result, n) => (result.status === 'done' ? [n] : []));
      assert.equal(done.length, 1, 'exactly one concurrent call wins');
      assert.equal(results.filter((result) => result.status === 'conflict').length, 7);
      assert.equal(effects, 1);
      assert.equal(store.getRun(id)?.title, `leader call ${done[0]}`);

      // A human write racing a leader call: the human's lands first, and the leader applies nothing.
      const leader = attempt(99)();
      store.updateRun(id, { title: 'the human won the race' });
      const raced = await leader;
      assert.equal(raced.status, 'conflict');
      assert.equal(store.getRun(id)?.title, 'the human won the race');
      assert.equal(effects, 1);
      store.flush();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- A-14 ----------------------------------------------------------------------------------------

describe('A-14 — a mutation executed but its response lost (N-10)', () => {
  /** A real effect: the run the cockpit's own store creates. */
  function createEffect(store: RunStore, counter: { n: number }) {
    return (): EffectOutcome => {
      counter.n += 1;
      const run = store.createRun({ title: 'created under an operation key', workflow: 'quick-task', task: 'same work', steps: [] });
      store.flush();
      return { outcome: 'ok', resultRef: { kind: 'run', id: run.id } };
    };
  }

  test('the same key retried gives the original result with EXACTLY ONE effect — also after a restart; a new key makes TWO', async () => {
    const dir = tempDir();
    try {
      const store = RunStore.open(dir);
      const counter = { n: 0 };
      const request = (operationId: string) => ({
        projectId: PROJECT,
        operationId,
        action: 'runs.create',
        payload: { prompt: 'same work' },
        reconcile: { kind: 'none' as const },
        effect: createEffect(store, counter),
      });
      let receipts = OperationReceiptStore.open(dir);
      const first = await receipts.execute(request('op-lost-response-1'));
      assert.equal(statusOf(first), 'ok');
      assert.ok('resultRef' in first && first.resultRef);
      // …the response is lost on the way back; the leader retries with the SAME key.
      const retry = await receipts.execute(request('op-lost-response-1'));
      assert.deepEqual(retry, { ...first, replayed: true });
      assert.equal(counter.n, 1, 'exactly one effect for a repeated key');
      assert.equal(store.listRuns().length, 1);

      // The retry arrives after a restart: the receipt is durable, not a memory of this process.
      receipts.close();
      receipts = OperationReceiptStore.open(dir);
      const afterRestart = await receipts.execute(request('op-lost-response-1'));
      assert.deepEqual(afterRestart, { ...first, replayed: true });
      assert.equal(counter.n, 1);

      // Intentionally new identical work takes a NEW key, and is a second task.
      const second = await receipts.execute(request('op-deliberately-new-2'));
      assert.equal(statusOf(second), 'ok');
      assert.ok('replayed' in second && second.replayed === false);
      assert.ok('resultRef' in second && second.resultRef && second.resultRef.id !== first.resultRef.id);
      assert.equal(counter.n, 2, 'two keys, two effects');
      assert.equal(store.listRuns().length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a collision — the same key with another payload or action — is refused explicitly, with no effect and no stored result', async () => {
    const dir = tempDir();
    try {
      const store = RunStore.open(dir);
      const counter = { n: 0 };
      const receipts = OperationReceiptStore.open(dir);
      const base = { projectId: PROJECT, operationId: 'op-collision-1', reconcile: { kind: 'none' as const }, effect: createEffect(store, counter) };
      await receipts.execute({ ...base, action: 'runs.create', payload: { prompt: 'same work' } });

      const otherPayload = await receipts.execute({ ...base, action: 'runs.create', payload: { prompt: 'other work' } });
      assert.equal('error' in otherPayload && otherPayload.error, 'operation_key_conflict');
      assert.ok('mismatch' in otherPayload && otherPayload.mismatch === 'payload');
      assert.equal('resultRef' in otherPayload, false, 'a collision returns no stored result');

      const otherAction = await receipts.execute({ ...base, action: 'runs.delete', payload: { prompt: 'same work' } });
      assert.ok('mismatch' in otherAction && otherAction.mismatch === 'action');
      assert.equal('resultRef' in otherAction, false);

      assert.equal(counter.n, 1, 'no collision ran an effect');
      assert.equal(store.listRuns().length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a crash between the effect and its receipt (a real SIGKILL) is explicitly UNVERIFIED and never repeated', { timeout: 60_000 }, async () => {
    const dir = tempDir();
    try {
      // The child opens the project's real stores, writes the intent, performs the effect (a real
      // task in the real RunStore), flushes it, says so and hangs before its settled line. It is
      // killed by its SAVED pid — never by a command-line pattern.
      const receiptsUrl = pathToFileURL(resolve(repoRoot, 'packages/xezar/src/mcp/operation-receipts.ts')).href;
      const storeUrl = pathToFileURL(resolve(repoRoot, 'packages/xezar/src/runs/store.ts')).href;
      const script = `
        import { OperationReceiptStore } from ${JSON.stringify(receiptsUrl)};
        import { RunStore } from ${JSON.stringify(storeUrl)};
        const dir = process.argv[1];
        const store = RunStore.open(dir);
        void OperationReceiptStore.open(dir).execute({
          projectId: ${JSON.stringify(PROJECT)}, operationId: 'op-crash-117', action: 'runs.create',
          payload: { prompt: 'same work' }, reconcile: { kind: 'none' },
          effect: () => {
            store.createRun({ title: 'created before the crash', workflow: 'quick-task', task: 'same work', steps: [] });
            store.flush();
            console.log('EFFECT');
            return new Promise(() => {});
          },
        });
        setInterval(() => {}, 1000);`;
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dir], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      try {
        await new Promise<void>((resolveReady, reject) => {
          let out = '';
          let err = '';
          child.stdout!.on('data', (chunk: Buffer) => {
            out += chunk.toString();
            if (out.includes('EFFECT')) resolveReady();
          });
          child.stderr!.on('data', (chunk: Buffer) => (err += chunk.toString()));
          child.on('exit', (code) => reject(new Error(`the child exited before its effect (${code}): ${err}`)));
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const ended = once(child, 'exit');
          child.kill('SIGKILL');
          await ended;
        }
      }

      const store = RunStore.open(dir);
      assert.equal(store.listRuns().length, 1, 'the effect happened before the crash');
      const counter = { n: 0 };
      const retry = () =>
        OperationReceiptStore.open(dir).execute({
          projectId: PROJECT,
          operationId: 'op-crash-117',
          action: 'runs.create',
          payload: { prompt: 'same work' },
          reconcile: { kind: 'none' },
          effect: createEffect(store, counter),
        });
      // An uncertain outcome is stated, not guessed.
      const answer = asUnverified(await retry());
      assert.equal(answer.guidance, UNVERIFIED_GUIDANCE);
      assert.equal(answer.operationId, 'op-crash-117');
      // …and it does not decay into "never happened" on the next retry either.
      asUnverified(await retry());
      assert.equal(counter.n, 0, 'the effect is never blindly repeated');
      assert.equal(store.listRuns().length, 1, 'still exactly one task');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an uncertain EXTERNAL outcome (the forge unreachable) is unverified, never not-applied, and never repeated', async () => {
    const dir = tempDir();
    try {
      let effects = 0;
      const credential = `ghp_${'x'.repeat(36)}`;
      const receipts = OperationReceiptStore.open(dir, {
        reconcilers: {
          'forge-search': () => {
            // What an offline `gh` says; its text must never reach the leader.
            throw new Error(`connect ECONNREFUSED api.github.com (token ${credential})`);
          },
        },
      });
      const request = {
        projectId: PROJECT,
        operationId: 'op-draft-pr-1',
        action: 'pr.create',
        payload: { taskId: 'task-1' },
        reconcile: { kind: 'forge-search' as const, repository: 'example/project', headBranch: 'xez/abcdef12' },
        effect: (): EffectOutcome => {
          effects += 1;
          // The request left; the answer did not come back.
          throw new Error('socket hang up');
        },
      };
      const first = asUnverified(await receipts.execute(request));
      assert.equal(first.reconcile.kind, 'forge-search');
      assert.equal(first.guidance, UNVERIFIED_GUIDANCE);
      assert.equal(JSON.stringify(first).includes(credential), false, 'the reconciler error text never reaches the answer');
      asUnverified(await receipts.execute(request));
      assert.equal(effects, 1, 'never repeated blindly');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- A-16 ----------------------------------------------------------------------------------------

describe('A-16 — older state with the MCP state absent or corrupt (N-07, N-08)', () => {
  /** An older xezar's state: a run record with none of the fields MCP-era xezar may add. */
  function seedOlderState(dir: string): string {
    const id = '0b6f4c1e-7a51-4d2a-9f41-3c1b0d7e8a90';
    writeFileSync(
      join(dir, 'runs.json'),
      JSON.stringify([
        {
          id,
          title: 'a task from an older xezar',
          workflow: 'quick-task',
          task: 'older brief',
          status: 'done',
          createdAt: '2026-01-02T03:04:05.000Z',
          tokensUsed: 0,
          steps: [{ id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0 }],
        },
      ]),
      'utf8',
    );
    return id;
  }

  function mcpFiles(dir: string) {
    return {
      journalIndex: join(dir, 'mcp', 'event-journal.json'),
      journalRows: join(dir, 'mcp', 'event-journal.ndjson'),
      cursors: join(dir, 'mcp', LEADER_CURSORS_FILE),
      controller: join(dir, 'mcp', 'event-controller.json'),
      receipts: join(dir, RECEIPT_JOURNAL_FILE),
      receiptSnapshot: join(dir, RECEIPT_SNAPSHOT_FILE),
      audit: auditTrailPath(dir),
    };
  }

  test('with every MCP state file absent, each store starts fresh and silently, and the older data is retained', async () => {
    const dir = tempDir();
    const journals: EventJournal[] = [];
    try {
      const olderRun = seedOlderState(dir);
      for (const path of Object.values(mcpFiles(dir))) assert.equal(existsSync(path), false);
      const warnings: string[] = [];
      const warn = (message: string) => warnings.push(message);

      const store = RunStore.open(dir);
      assert.equal(store.getRun(olderRun)?.title, 'a task from an older xezar', 'older state parses unchanged');

      const journal = EventJournal.open({ dataDir: dir, projectId: PROJECT, secretValues: [], warn });
      journals.push(journal);
      assert.equal(journal.latestSeq, 0);
      assert.ok(journal.append(terminalRow(olderRun, null)), 'the fresh journal accepts rows');

      const cursors = LeaderCursors.open({ dataDir: dir, projectId: PROJECT, journal, warn });
      assert.equal(cursors.fresh, true, 'a leader that never connected starts at the head, and says so');

      const { value: receipts, warnings: receiptWarnings } = await capturingWarn(() => OperationReceiptStore.open(dir));
      assert.deepEqual(receipts.stats(), { receipts: 0, quarantined: 0, live: 0 });
      let effects = 0;
      const answer = await receipts.execute({
        projectId: PROJECT,
        operationId: 'op-after-upgrade',
        action: 'runs.pin',
        payload: { pinned: true },
        reconcile: { kind: 'none' },
        effect: () => {
          effects += 1;
          return { outcome: 'ok', resultRef: { kind: 'run', id: olderRun } };
        },
      });
      assert.equal(statusOf(answer), 'ok');
      assert.equal(effects, 1);

      const audit = new AuditTrail({ projectId: PROJECT, dataDir: dir }, { warn });
      assert.deepEqual(audit.read(), { entries: [], quarantined: 0 });
      assert.ok(audit.channel('mcp').record({ action: 'mcp.task-read' }, { outcome: 'ok' }));

      assert.deepEqual(warnings, [], 'deleted state is a fresh start, not a warning');
      assert.deepEqual(receiptWarnings, []);
      assert.equal(store.getRun(olderRun)?.status, 'done', 'the older task is retained');
    } finally {
      for (const journal of journals) journal.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with every MCP state file corrupt: nothing throws, one warning per store, nothing replays as valid, the bad bytes are kept', async () => {
    const dir = tempDir();
    const journals: EventJournal[] = [];
    try {
      const olderRun = seedOlderState(dir);
      const files = mcpFiles(dir);
      mkdirSync(join(dir, 'mcp'), { recursive: true });
      const garbage = '{"this is": not a journal\n';
      for (const path of Object.values(files)) writeFileSync(path, garbage, 'utf8');

      const store = RunStore.open(dir);
      assert.equal(store.getRun(olderRun)?.title, 'a task from an older xezar', 'older state is untouched by MCP damage');

      // The event journal: set aside, a fresh epoch, one warning.
      const journalWarnings: string[] = [];
      const journal = EventJournal.open({ dataDir: dir, projectId: PROJECT, secretValues: [], warn: (m) => journalWarnings.push(m) });
      journals.push(journal);
      assert.equal(journalWarnings.length, 1);
      assert.match(journalWarnings[0]!, /corrupt/);
      assert.equal(readFileSync(`${files.journalRows}.corrupt`, 'utf8'), garbage, 'the corrupt rows are kept beside the fresh journal');
      assert.equal(journal.latestSeq, 0, 'nothing from the corrupt file is replayed as valid');
      assert.ok(journal.append(terminalRow(olderRun, null)));

      // The leader's cursors: restart at the head, stated, one warning, the bad file kept.
      const cursorWarnings: string[] = [];
      const cursors = LeaderCursors.open({ dataDir: dir, projectId: PROJECT, journal, warn: (m) => cursorWarnings.push(m) });
      assert.equal(cursors.fresh, true);
      assert.equal(cursorWarnings.length, 1);
      assert.equal(readFileSync(`${files.cursors}.corrupt`, 'utf8'), garbage);

      // The operation receipts: damage is quarantined, and a key miss is NOT a licence to execute
      // (no expanded authority): with nothing able to answer, it is unverified and nothing runs.
      const { value: receipts, warnings: receiptWarnings } = await capturingWarn(() => OperationReceiptStore.open(dir));
      assert.ok(receipts.stats().quarantined >= 1);
      assert.equal(receiptWarnings.length, 1);
      let effects = 0;
      const miss = await receipts.execute({
        projectId: PROJECT,
        operationId: 'op-maybe-in-the-damage',
        action: 'runs.create',
        payload: { prompt: 'x' },
        reconcile: { kind: 'none' },
        effect: () => {
          effects += 1;
          return { outcome: 'ok', resultRef: { kind: 'run', id: 'never' } };
        },
      });
      asUnverified(miss);
      assert.equal(effects, 0);
      assert.ok(readFileSync(files.receipts, 'utf8').startsWith(garbage.trimEnd()), 'the damaged journal is not truncated away');

      // The audit trail: the bad line is skipped, never fatal, and appending still works.
      const auditWarnings: string[] = [];
      const audit = new AuditTrail({ projectId: PROJECT, dataDir: dir }, { warn: (m) => auditWarnings.push(m) });
      assert.deepEqual(audit.read(), { entries: [], quarantined: 1 });
      assert.ok(audit.channel('mcp').record({ action: 'mcp.task-read' }, { outcome: 'ok' }));
      assert.equal(audit.read().entries.length, 1);
      assert.deepEqual(auditWarnings, []);

      // The event controller's cursor file: an unreadable one starts at the head WITH a stated gap.
      const ownership = new ProjectOwnership({ dataDir: dir, projectId: PROJECT, autoRenew: false });
      const owner = await ownership.acquire('session-1');
      assert.equal(owner.outcome, 'owner');
      const dispatches: EventDispatch[] = [];
      const controllerWarnings: string[] = [];
      const started = EventController.start({
        journal,
        ownership,
        sessionKey: 'session-1',
        adapter: { deliver: async (dispatch) => void dispatches.push(dispatch) },
        heartbeatMs: 60_000,
        warn: (m) => controllerWarnings.push(m),
      });
      assert.equal(started.outcome, 'started');
      try {
        journal.append(terminalRow(olderRun, null, 'after the damage'));
        for (let i = 0; i < 50 && dispatches.length === 0; i += 1) await new Promise((done) => setTimeout(done, 5));
        assert.ok(dispatches.length >= 1, 'the controller still delivers');
        assert.ok(dispatches.some((dispatch) => dispatch.recovery?.required === 'current-state'), 'the lost position is a stated gap');
        assert.ok(controllerWarnings.length <= 1);
      } finally {
        started.controller.close();
        ownership.release('session-1');
        ownership.dispose();
      }
      assert.equal(store.getRun(olderRun)?.status, 'done', 'the older task is retained');
    } finally {
      for (const journal of journals) journal.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a restart never makes two project owners: the old session is fenced, the next one owns alone', async () => {
    const dir = tempDir();
    try {
      let firstAlive = true;
      // Two service processes over one data directory, the first of which "dies" (a restart).
      const first = new ProjectOwnership({ dataDir: dir, projectId: PROJECT, autoRenew: false, pid: 111_111, isAlive: (pid) => pid !== 111_111 || firstAlive });
      const second = new ProjectOwnership({ dataDir: dir, projectId: PROJECT, autoRenew: false, pid: 222_222, isAlive: (pid) => pid !== 111_111 || firstAlive });
      const a = await first.acquire('leader-before-restart');
      assert.equal(a.outcome, 'owner');
      const contender = await second.acquire('another-client');
      assert.equal(contender.outcome, 'occupied', 'a second client while the first owns: refused, not a second owner');

      firstAlive = false;
      const b = await second.acquire('leader-after-restart');
      assert.equal(b.outcome, 'owner', 'after the restart the new session owns the project');
      assert.ok(a.outcome === 'owner' && b.outcome === 'owner');
      assert.equal(second.checkMutation(a.token).ok, false, 'a write from before the restart is fenced');
      assert.equal(second.checkMutation(b.token).ok, true);
      first.dispose();
      second.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- A-21 ----------------------------------------------------------------------------------------

describe('A-21 — reconnect with a valid cursor, an old cursor, duplicates and out-of-order rows (F-21, N-10)', () => {
  test('retention is the documented design value, not an assumption: the journal bounds equal D-05 N1/N2 and D-09 B-01/B-19/B-20', () => {
    assert.equal(MCP_JOURNAL_RETAINED_ROWS, 10_000);
    assert.equal(MCP_JOURNAL_MIN_RETENTION_DAYS, 14);
    assert.equal(MCP_JOURNAL_PAGE_ROWS, 100);
    assert.equal(MCP_JOURNAL_PAGE_BYTES, 40_000);
    const d09 = readFileSync(join(repoRoot, 'docs/features/mcp-server/mcp-d09-limits-retention-packaging-decision.md'), 'utf8');
    const d05 = readFileSync(join(repoRoot, 'docs/features/mcp-server/mcp-d05-async-event-contract-decision.md'), 'utf8');
    assert.match(d09, /\| B-19 \| Event journal \| \*\*10 000\*\* rows per project, and a row younger than \*\*14\*\* days is never evicted/);
    assert.match(d09, /\| B-20 \| Journal replay page \| \*\*100\*\* rows/);
    assert.match(d09, /\| B-01 \| MCP tool-result budget [^|]*\| \*\*40 000\*\* \| bytes/);
    assert.match(d05, /\| N1 \| \*\*Journal retention: 10 000 rows per project, and never less than 14 days\*\*/);
  });

  test('a valid cursor gets exactly the outstanding rows, in journal order, then the current state', () => {
    const dir = tempDir();
    const journal = EventJournal.open({ dataDir: dir, projectId: PROJECT, secretValues: [], warn: () => {} });
    try {
      const store = RunStore.open(dir);
      const id = queuedTask(store);
      for (let i = 1; i <= 5; i += 1) journal.append(terminalRow(id, runVersion(store, id) ?? null, `row ${i}`));
      const cursors = LeaderCursors.open({ dataDir: dir, projectId: PROJECT, journal, warn: () => {} });
      const afterTwo = journal.read({ limit: 2 });
      assert.ok(afterTwo.status === 'ok');
      const answer = reconnect({ journal, cursors, readState: runStateReader(store, journal), cursor: afterTwo.nextCursor });
      assert.ok(answer.status === 'ok');
      assert.deepEqual(answer.events.map((delivered) => delivered.row.journalSeq), [3, 4, 5]);
      assert.equal(answer.hasMore, false);
      assert.equal(answer.state.latestSeq, 5);
      assert.deepEqual(answer.state.tasks, [{ id, status: 'queued', version: runVersion(store, id) }]);
      store.flush();
    } finally {
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a cursor older than retention is an EXPLICIT gap that names its recovery path, and following it recovers', () => {
    const dir = tempDir();
    let now = Date.parse('2026-09-01T00:00:00.000Z');
    let journal = EventJournal.open({ dataDir: dir, projectId: PROJECT, secretValues: [], warn: () => {}, now: () => now });
    try {
      const store = RunStore.open(dir);
      const id = queuedTask(store);
      journal.append(terminalRow(id, null, 'the row the offline leader last saw'));
      const oldCursor = journal.headCursor();
      for (let i = 0; i < MCP_JOURNAL_RETAINED_ROWS; i += 1) journal.append(terminalRow(id, null, `row ${i}`));
      now += (MCP_JOURNAL_MIN_RETENTION_DAYS + 1) * DAY_MS;
      journal.append(terminalRow(id, null, 'the newest row'));
      assert.ok((journal.oldestSeq ?? 0) > 2, 'retention evicted the rows after the old cursor');

      const cursors = LeaderCursors.open({ dataDir: dir, projectId: PROJECT, journal, warn: () => {} });
      const gap = reconnect({ journal, cursors, readState: runStateReader(store, journal), cursor: oldCursor });
      assert.equal(gap.status, 'cursor_too_old');
      assert.ok(gap.status === 'cursor_too_old');
      assert.equal(gap.gap.recovery.required, 'current-state');
      assert.match(gap.gap.recovery.message, /Read the current state first/);
      assert.match(gap.gap.recovery.message, /resumeCursor/);
      assert.equal(gap.gap.oldestSeq, journal.oldestSeq);
      assert.deepEqual(gap.state.tasks.map((task) => task.id), [id], 'the current state rides with the gap');
      assert.equal('events' in gap, false, 'nothing is replayed partially');

      // Following the named recovery: current state read above, then continue from resumeCursor.
      const resumed = reconnect({ journal, cursors, readState: runStateReader(store, journal), cursor: gap.gap.resumeCursor });
      assert.ok(resumed.status === 'ok');
      assert.equal(resumed.events[0]?.row.journalSeq, journal.oldestSeq, 'the resume starts at the oldest retained row');
      assert.equal(resumed.hasMore, true, 'the rest is paged on request, never dropped');

      // A journal recreated from damage is a new epoch: the old cursor is the same explicit gap.
      journal.close();
      writeFileSync(join(dir, 'mcp', 'event-journal.json'), '{broken', 'utf8');
      journal = EventJournal.open({ dataDir: dir, projectId: PROJECT, secretValues: [], warn: () => {}, now: () => now });
      const recreated = reconnect({ journal, cursors: LeaderCursors.open({ dataDir: dir, projectId: PROJECT, journal, warn: () => {} }), readState: runStateReader(store, journal), cursor: oldCursor });
      assert.equal(recreated.status, 'cursor_too_old');
      store.flush();
    } finally {
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('duplicates and out-of-order rows are released once, in order, with the gap stated; a redelivered reaction replays with no second effect', async () => {
    const dir = tempDir();
    const journal = EventJournal.open({ dataDir: dir, projectId: PROJECT, secretValues: [], warn: () => {} });
    try {
      const rows: McpJournalRow[] = [1, 2, 3].map((i) => journal.append(terminalRow(`run-${i}`, null, `row ${i}`))!);
      const inbox = new LeaderInbox({ projectId: PROJECT, afterSeq: 0 });
      const early = inbox.accept([rows[2]!, rows[0]!]);
      assert.deepEqual(early.deliver.map((row) => row.journalSeq), [1]);
      assert.deepEqual(early.missing, { fromSeq: 2, toSeq: 2 }, 'the missing row is stated, not skipped');
      const late = inbox.accept([rows[1]!, rows[0]!, rows[2]!]);
      assert.deepEqual(late.deliver.map((row) => row.journalSeq), [2, 3]);
      assert.equal(late.duplicates, 2);
      assert.equal(late.missing, null);

      // The inbox is lost (a restart) and row 2 arrives again: the reaction's key replays it.
      const receipts = OperationReceiptStore.open(dir);
      let effects = 0;
      const react = (row: McpJournalRow) =>
        receipts.execute({
          projectId: PROJECT,
          operationId: reactionOperationId(journal.epoch, row, 'start-review'),
          action: 'runs.create',
          payload: { reactingTo: row.eventId },
          reconcile: { kind: 'none' },
          effect: () => {
            effects += 1;
            return { outcome: 'ok', resultRef: { kind: 'run', id: `review-of-${row.journalSeq}` } };
          },
        });
      const once1 = await react(rows[1]!);
      const again = await react(rows[1]!);
      assert.equal(effects, 1);
      assert.deepEqual(again, { ...once1, replayed: true });
    } finally {
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
