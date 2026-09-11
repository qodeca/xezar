import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { AutomationStore } from '../automations/store.ts';
import { branchFor, removeWorktree, worktreeDiffStat, worktreePathFor } from '../git-worktree.ts';
import { projectDataDir } from '../project-data-paths.ts';
import { reclaimWorktrees } from '../runs/retention.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { readWorktreePath } from '../server/git-changes.ts';
import {
  MCP_CURSOR_MAX_BYTES,
  openCursor,
  ownAutomation,
  ownAutomationCheck,
  ownAutomationReceipt,
  ownershipScope,
  ownGroup,
  ownGroupMember,
  ownQueuedMessage,
  ownRun,
  ownSweep,
  ownWorkflow,
  ownWorkingDirectory,
  ownWorktree,
  ownWorktreeFile,
  partitionOwned,
  sealCursor,
  stampOwner,
  type OwnershipAuditEntry,
  type OwnershipScope,
} from './resource-ownership.ts';

/**
 * #88 — per-resource ownership (F-02, N-01, N-02, A-03, A-04).
 *
 * Two real projects on disk, ALPHA (the bound project) and BRAVO (the victim), each a git repo
 * with its own RunStore and AutomationStore, and a real git worktree per task. ALPHA's store also
 * holds two HOSTILE records — the shapes a copied or hand-edited `.local/xezar` produces:
 *
 *  - `alphaStray`: a finished variant whose `worktreePath` names BRAVO's worktree. The pick and
 *    reclaim flows `rm -rf` exactly that path (`removeWorktree`).
 *  - `alphaLinked`: a variant whose worktree directory, at ALPHA's own expected path, is a symlink
 *    to BRAVO's worktree. `readWorktreePath` resolves its ROOT through the link, so the files
 *    route would serve BRAVO's files from it.
 *
 * Every case goes through `attempt`, which records BRAVO's complete state and external effects
 * (every file's bytes and mtime, symlink targets, git refs and worktree registrations, both of
 * BRAVO's in-memory stores) BEFORE the call and asserts it is identical AFTER — and asserts on
 * the response, on both projects' event streams and on the leader-visible log (the audit sink
 * plus anything written to the console). A-03: an error code alone proves nothing.
 *
 * The flows below are what an MCP tool does: validate, and only on `ok` call the SAME service the
 * cockpit route calls (N-02). A refused flow therefore never reaches the service at all.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

function initRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), `# ${root.split('/').pop()}\n`);
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'init');
}

function addWorktree(root: string, run: RunRecord, store: RunStore): string {
  const path = worktreePathFor(root, run.id);
  git(root, 'worktree', 'add', '-q', '-b', branchFor(run.id), path);
  store.updateRun(run.id, { worktreePath: path, branch: branchFor(run.id) });
  return path;
}

const finished = (store: RunStore, id: string, finishedAt: string, extra: Partial<RunRecord> = {}): void => {
  store.updateRun(id, { status: 'done', finishedAt, ...extra });
};

const automationInput = (name: string) => ({
  name,
  enabled: false,
  events: ['pull_request.opened' as const],
  intervalSeconds: 300,
  filters: { lookbackDays: 7, maxRecords: 25 },
  task: { prompt: `${name} prompt` },
});

type ManualCheck = { id: string; automationId: string; mode: 'preview'; status: 'complete'; createdAt: string };

function buildFixture() {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'xez-88-'));
  const rootA = join(base, 'project-alpha');
  const rootB = join(base, 'project-bravo');
  initRepo(rootA);
  initRepo(rootB);
  const storeA = RunStore.open(projectDataDir(rootA));
  const storeB = RunStore.open(projectDataDir(rootB));
  const autoStoreA = AutomationStore.open(projectDataDir(rootA));
  const autoStoreB = AutomationStore.open(projectDataDir(rootB));
  const newRun = (store: RunStore, title: string, extra: { groupId?: string; variant?: string } = {}) =>
    store.createRun({ title, workflow: 'quick-task', task: `${title} task`, steps: [], ...extra });

  // ---- BRAVO: the victim ----------------------------------------------------
  const bravoRun = newRun(storeB, 'bravo secret title', { groupId: 'group-bravo', variant: 'a' });
  finished(storeB, bravoRun.id, '2026-09-01T10:00:00.000Z', {
    queuedMessages: [{ id: 'msg-bravo-1', text: 'bravo queued words', createdAt: '2026-09-01T09:00:00.000Z' }],
  });
  const bravoWorktree = addWorktree(rootB, bravoRun, storeB);
  writeFileSync(join(bravoWorktree, 'secret.txt'), 'BRAVO-SECRET-CONTENT\n');
  const bravoAutomation = autoStoreB.create(automationInput('bravo automation'));
  const bravoReceipt = autoStoreB.reserveReceipt({ automationId: bravoAutomation.id, revision: 1, eventId: 'evt-bravo' })!;
  const bravoCheck: ManualCheck = { id: 'check-bravo-7f3a', automationId: bravoAutomation.id, mode: 'preview', status: 'complete', createdAt: '2026-09-01T10:00:00.000Z' };
  stampOwner(bravoCheck, { root: rootB });

  // ---- ALPHA: the bound project ---------------------------------------------
  const alphaRun = newRun(storeA, 'alpha main');
  finished(storeA, alphaRun.id, '2026-09-03T10:00:00.000Z', {
    queuedMessages: [{ id: 'msg-alpha-1', text: 'alpha queued words', createdAt: '2026-09-03T09:00:00.000Z' }],
  });
  const alphaWorktree = addWorktree(rootA, alphaRun, storeA);
  writeFileSync(join(alphaWorktree, 'notes.txt'), 'alpha notes\n');
  mkdirSync(join(alphaWorktree, 'sub'));
  writeFileSync(join(alphaWorktree, 'sub', 'deep.txt'), 'alpha deep\n');
  symlinkSync(join(bravoWorktree, 'secret.txt'), join(alphaWorktree, 'leak.txt'));
  symlinkSync(rootB, join(alphaWorktree, 'bravo'));

  const alphaInPlace = storeA.createRun({ title: 'alpha in place', workflow: 'quick-task', task: 't', worktree: false, steps: [] });
  storeA.updateRun(alphaInPlace.id, { status: 'running' });

  const alphaBulk1 = newRun(storeA, 'alpha bulk one');
  finished(storeA, alphaBulk1.id, '2026-09-02T10:00:00.000Z');
  const alphaBulk2 = newRun(storeA, 'alpha bulk two');
  finished(storeA, alphaBulk2.id, '2026-09-02T11:00:00.000Z');

  const alphaVariantA = newRun(storeA, 'alpha variant a', { groupId: 'group-alpha', variant: 'a' });
  const alphaVariantB = newRun(storeA, 'alpha variant b', { groupId: 'group-alpha', variant: 'b' });
  finished(storeA, alphaVariantA.id, '2026-09-02T12:00:00.000Z');
  finished(storeA, alphaVariantB.id, '2026-09-02T12:00:00.000Z');

  // Hostile record 1: ALPHA's store, BRAVO's worktree path. Cancelled and archived, so the
  // archive and read-all sweeps never touch it, while reclaim (finished + worktreePath) does.
  const alphaLegit = newRun(storeA, 'alpha mixed legit', { groupId: 'group-mixed', variant: 'a' });
  finished(storeA, alphaLegit.id, '2026-09-02T13:00:00.000Z');
  const alphaStray = newRun(storeA, 'alpha mixed stray', { groupId: 'group-mixed', variant: 'b' });
  storeA.updateRun(alphaStray.id, { status: 'cancelled', finishedAt: '2026-08-01T10:00:00.000Z', worktreePath: bravoWorktree, branch: branchFor(bravoRun.id) });
  storeA.setArchived(alphaStray.id, true);

  // Hostile record 2: ALPHA's own expected worktree path, but the directory is a symlink to BRAVO's.
  const alphaLinked = newRun(storeA, 'alpha linked', { groupId: 'group-linked', variant: 'a' });
  const alphaLinkedMate = newRun(storeA, 'alpha linked mate', { groupId: 'group-linked', variant: 'b' });
  const linkedPath = worktreePathFor(rootA, alphaLinked.id);
  symlinkSync(bravoWorktree, linkedPath);
  storeA.updateRun(alphaLinked.id, { status: 'running', worktreePath: linkedPath });
  finished(storeA, alphaLinkedMate.id, '2026-09-02T14:00:00.000Z');

  const alphaAutomation = autoStoreA.create(automationInput('alpha automation'));
  const alphaReceipt = autoStoreA.reserveReceipt({ automationId: alphaAutomation.id, revision: 1, eventId: 'evt-alpha' })!;
  const alphaCheck: ManualCheck = { id: 'check-alpha-1c2d', automationId: alphaAutomation.id, mode: 'preview', status: 'complete', createdAt: '2026-09-03T10:00:00.000Z' };
  stampOwner(alphaCheck, { root: rootA });
  // A check created before owners were stamped: it names ALPHA's automation, but nothing proves who made it.
  const unstampedCheck: ManualCheck = { ...alphaCheck, id: 'check-unstamped-9e8f' };
  // The workspace-level map, shared by every project exactly as `manualChecks` in server.ts is.
  const checks = new Map<string, ManualCheck>([alphaCheck, unstampedCheck, bravoCheck].map((c) => [c.id, c]));

  storeA.flush();
  storeB.flush();

  const bravoNames = [
    bravoRun.id,
    branchFor(bravoRun.id),
    'msg-bravo-1',
    'bravo queued words',
    'group-bravo',
    'bravo secret title',
    bravoAutomation.id,
    'bravo automation',
    bravoReceipt.receiptId,
    bravoCheck.id,
    rootB,
    'project-bravo',
    'BRAVO-SECRET-CONTENT',
  ];

  return {
    base, rootA, rootB, storeA, storeB, autoStoreA, autoStoreB, checks, bravoNames,
    bravoRun, bravoWorktree, bravoAutomation, bravoReceipt, bravoCheck,
    alphaRun, alphaWorktree, alphaInPlace, alphaBulk1, alphaBulk2, alphaVariantA, alphaVariantB, alphaLegit, alphaStray,
    alphaLinked, alphaLinkedMate, alphaAutomation, alphaReceipt, alphaCheck, unstampedCheck,
  };
}

type Fixture = ReturnType<typeof buildFixture>;

/** Everything BRAVO is, on disk and in memory, and everything outside it that names it. */
function bravoState(f: Fixture): string {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const info = lstatSync(path);
      const rel = path.slice(f.rootB.length);
      if (info.isSymbolicLink()) entries.push(`L ${rel} -> ${readlinkSync(path)}`);
      else if (info.isDirectory()) {
        entries.push(`D ${rel} ${info.mode}`);
        walk(path);
      } else {
        const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
        entries.push(`F ${rel} ${info.size} ${info.mtimeMs} ${info.mode} ${hash}`);
      }
    }
  };
  walk(f.rootB);
  return JSON.stringify({
    files: entries,
    refs: git(f.rootB, 'for-each-ref', '--format=%(refname) %(objectname)'),
    worktrees: git(f.rootB, 'worktree', 'list', '--porcelain'),
    runs: f.storeB.listRuns(),
    automations: f.autoStoreB.list(),
    receipts: f.autoStoreB.receipts(),
    checks: [...f.checks.values()].filter((c) => c.id === f.bravoCheck.id),
  });
}

interface Observation {
  response: unknown;
  audit: OwnershipAuditEntry[];
  eventsA: unknown[];
  eventsB: unknown[];
  log: string[];
}

describe('resource ownership (#88)', () => {
  let f: Fixture;
  let audit: OwnershipAuditEntry[];
  let log: string[];
  let eventsA: unknown[];
  let eventsB: unknown[];
  let scope: OwnershipScope;

  beforeAll(() => {
    f = buildFixture();
    const record = (sink: () => unknown[], kind: string) => (payload: unknown) => sink().push({ kind, payload });
    for (const kind of ['run', 'event', 'deleted']) {
      f.storeA.on(kind, record(() => eventsA, kind));
      f.storeB.on(kind, record(() => eventsB, kind));
    }
  }, 60_000);

  afterAll(() => {
    f.storeA.flush();
    f.storeB.flush();
    rmSync(f.base, { recursive: true, force: true });
  });

  beforeEach(() => {
    audit = [];
    log = [];
    eventsA = [];
    eventsB = [];
    scope = ownershipScope({ root: f.rootA, store: f.storeA, automationStore: f.autoStoreA }, (e) => audit.push(e));
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        log.push(args.map(String).join(' '));
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Run one flow and hold it to A-03: BRAVO unchanged, nothing names BRAVO anywhere. */
  async function attempt(flow: () => unknown): Promise<Observation> {
    const before = bravoState(f);
    const response = await flow();
    const after = bravoState(f);
    expect(after).toBe(before);
    expect(eventsB).toEqual([]);
    const observed = { response, audit: [...audit], eventsA: [...eventsA], eventsB: [...eventsB], log: [...log] };
    const text = JSON.stringify(observed);
    for (const name of f.bravoNames) expect(text).not.toContain(name);
    return observed;
  }

  // ---- flows: validate, then call the service the cockpit route calls ------------------------

  const pickFlow = async (groupId: string, runId: string) => {
    const owned = await ownGroupMember(scope, groupId, runId);
    if (!owned.ok) return owned;
    for (const loser of owned.value.runs.filter((r) => r.id !== owned.value.run.id)) {
      if (loser.worktreePath) await removeWorktree(f.rootA, loser.worktreePath, loser.branch);
      f.storeA.updateRun(loser.id, { worktreePath: undefined, branch: undefined });
      f.storeA.setArchived(loser.id, true);
    }
    return { ok: true, winner: owned.value.run.id };
  };

  const groupReadFlow = async (groupId: string) => {
    const owned = await ownGroup(scope, groupId);
    if (!owned.ok) return owned;
    return {
      ok: true,
      runs: await Promise.all(
        owned.value.runs.map(async (r) => ({ id: r.id, diffStat: r.worktreePath ? await worktreeDiffStat(r.worktreePath, 'HEAD') : '' })),
      ),
    };
  };

  const fileFlow = async (runId: string, path: string) => {
    const owned = await ownWorktreeFile(scope, runId, path);
    if (!owned.ok) return owned;
    return { ok: true, result: await readWorktreePath(owned.value.directory, owned.value.path) };
  };

  const deleteMessageFlow = (runId: string, msgId: string) => {
    const owned = ownQueuedMessage(scope, runId, msgId);
    if (!owned.ok) return owned;
    f.storeA.updateRun(owned.value.run.id, { queuedMessages: (owned.value.run.queuedMessages ?? []).filter((m) => m.id !== msgId) });
    return { ok: true };
  };

  const checkFlow = (checkId: string) => ownAutomationCheck(scope, checkId, f.checks);

  const cursorFlow = (resource: string, cursor: unknown) => openCursor(scope, resource, cursor);

  // ---- A-03 / A-04: every foreign identifier is refused before any read or mutation -----------

  it('refuses a B run id — every run-shaped entry point', async () => {
    const seen = await attempt(async () => [
      ownRun(scope, f.bravoRun.id),
      await ownWorktree(scope, f.bravoRun.id),
      await ownWorkingDirectory(scope, f.bravoRun.id),
      await fileFlow(f.bravoRun.id, 'secret.txt'),
      deleteMessageFlow(f.bravoRun.id, 'msg-bravo-1'),
    ]);
    expect(seen.response).toEqual(Array(5).fill({ ok: false, code: 'not_found', message: 'not found in this project' }));
    expect(seen.audit).toEqual(Array(5).fill({ check: 'run', code: 'not_found' }));
    expect(seen.eventsA).toEqual([]);
    expect(seen.log).toEqual([]);
  });

  it('refuses a B message id nested inside an A run', async () => {
    const seen = await attempt(() => deleteMessageFlow(f.alphaRun.id, 'msg-bravo-1'));
    expect(seen.response).toEqual({ ok: false, code: 'not_found', message: 'not found in this project' });
    expect(seen.audit).toEqual([{ check: 'queued-message', code: 'not_found' }]);
    expect(seen.eventsA).toEqual([]);
    expect(seen.log).toEqual([]);
    expect(f.storeA.getRun(f.alphaRun.id)?.queuedMessages?.map((m) => m.id)).toEqual(['msg-alpha-1']);
  });

  it('refuses a group containing a foreign run — read and pick — and never deletes the foreign worktree', async () => {
    const seen = await attempt(async () => [
      await groupReadFlow('group-mixed'),
      await pickFlow('group-mixed', f.alphaLegit.id),
      await groupReadFlow('group-linked'),
      await pickFlow('group-linked', f.alphaLinkedMate.id),
    ]);
    expect(seen.response).toEqual(Array(4).fill({ ok: false, code: 'not_found', message: 'not found in this project' }));
    expect(seen.audit).toEqual(Array(4).fill({ check: 'group', code: 'not_found' }));
    expect(seen.eventsA).toEqual([]);
    expect(seen.log).toEqual([]);
    expect(f.storeA.getRun(f.alphaLegit.id)?.archived).toBe(false);
  });

  it('refuses a B group, and a B run named as the winner of an A group', async () => {
    const seen = await attempt(async () => [
      await groupReadFlow('group-bravo'),
      await pickFlow('group-alpha', f.bravoRun.id),
    ]);
    expect(seen.response).toEqual(Array(2).fill({ ok: false, code: 'not_found', message: 'not found in this project' }));
    expect(seen.audit).toEqual([{ check: 'group', code: 'not_found' }, { check: 'group-member', code: 'not_found' }]);
    expect(seen.eventsA).toEqual([]);
    expect(f.storeA.getRun(f.alphaVariantA.id)?.archived).toBe(false);
    expect(f.storeA.getRun(f.alphaVariantB.id)?.archived).toBe(false);
  });

  it('refuses a B automation-check id behind the workspace-level map, and an unstamped check', async () => {
    const seen = await attempt(() => [checkFlow(f.bravoCheck.id), checkFlow(f.unstampedCheck.id)]);
    expect(seen.response).toEqual(Array(2).fill({ ok: false, code: 'not_found', message: 'not found in this project' }));
    expect(seen.audit).toEqual(Array(2).fill({ check: 'automation-check', code: 'not_found' }));
    expect(seen.eventsA).toEqual([]);
    expect(seen.log).toEqual([]);
  });

  it('refuses a B automation and a B automation result (receipt)', async () => {
    const seen = await attempt(() => [ownAutomation(scope, f.bravoAutomation.id), ownAutomationReceipt(scope, f.bravoReceipt.receiptId)]);
    expect(seen.response).toEqual(Array(2).fill({ ok: false, code: 'not_found', message: 'not found in this project' }));
    expect(seen.audit).toEqual([{ check: 'automation', code: 'not_found' }, { check: 'automation-receipt', code: 'not_found' }]);
    expect(seen.eventsA).toEqual([]);
  });

  it('refuses an absolute path, a `..` path and symlink paths without reading them', async () => {
    const dotdot = `../../../../project-bravo/.local/xezar/worktrees/${f.bravoRun.id}/secret.txt`;
    const seen = await attempt(async () => [
      await fileFlow(f.alphaRun.id, join(f.bravoWorktree, 'secret.txt')),
      await fileFlow(f.alphaRun.id, dotdot),
      await fileFlow(f.alphaRun.id, 'leak.txt'),
      await fileFlow(f.alphaRun.id, 'bravo/README.md'),
      await fileFlow(f.alphaRun.id, '.git/config'),
      await fileFlow(f.alphaRun.id, 'sub\\..\\..\\x'),
    ]);
    const forbidden = { ok: false, code: 'forbidden_path', message: expect.stringContaining('path not allowed') };
    expect(seen.response).toEqual(Array(6).fill(forbidden));
    expect(seen.audit).toEqual(Array(6).fill({ check: 'file', code: 'forbidden_path' }));
    expect(seen.eventsA).toEqual([]);
    expect(seen.log).toEqual([]);
  });

  it('refuses the engine runtime folder of a run that works in the project root (F-15)', async () => {
    writeFileSync(join(projectDataDir(f.rootA), 'launch-key'), 'ALPHA-LAUNCH-KEY\n');
    const seen = await attempt(async () => [
      await fileFlow(f.alphaInPlace.id, '.local/xezar/launch-key'),
      await fileFlow(f.alphaInPlace.id, '.LOCAL/xezar/runs.json'),
    ]);
    expect(seen.response).toEqual(Array(2).fill({ ok: false, code: 'forbidden_path', message: expect.stringContaining('path not allowed') }));
    expect(JSON.stringify(seen)).not.toContain('ALPHA-LAUNCH-KEY');
    // Control: the same run still reads the project's own files.
    expect(await fileFlow(f.alphaInPlace.id, 'README.md')).toMatchObject({ ok: true, result: { kind: 'file', content: '# project-alpha\n' } });
  });

  it('refuses every file of a run whose worktree directory is a symlink into B', async () => {
    const seen = await attempt(async () => [
      await fileFlow(f.alphaLinked.id, 'secret.txt'),
      await fileFlow(f.alphaLinked.id, ''),
      await ownWorktree(scope, f.alphaLinked.id),
    ]);
    expect(seen.response).toEqual(Array(3).fill({ ok: false, code: 'not_found', message: 'not found in this project' }));
    expect(seen.audit).toEqual(Array(3).fill({ check: 'worktree', code: 'not_found' }));
  });

  it('refuses a foreign pagination cursor', async () => {
    const bravoScope = ownershipScope({ root: f.rootB, store: f.storeB, automationStore: f.autoStoreB });
    const bravoCursor = sealCursor(bravoScope, `run:${f.bravoRun.id}:history`, 'page-2');
    const seen = await attempt(() => [
      cursorFlow(`run:${f.alphaRun.id}:history`, bravoCursor),
      cursorFlow(`run:${f.bravoRun.id}:history`, bravoCursor),
    ]);
    expect(seen.response).toEqual(Array(2).fill({ ok: false, code: 'invalid_cursor', message: 'invalid cursor — request the first page again' }));
    expect(seen.audit).toEqual(Array(2).fill({ check: 'cursor', code: 'invalid_cursor' }));
    // The cursor itself names nothing: neither the project nor the resource is written into it.
    const decoded = Buffer.from(bravoCursor, 'base64url').toString('utf8');
    for (const name of f.bravoNames) expect(decoded).not.toContain(name);
  });

  it('refuses the reclaim sweep as a whole while a record reaches outside the project', async () => {
    const seen = await attempt(async () => {
      const owned = await ownSweep(scope, 'reclaim-worktrees');
      if (!owned.ok) return owned;
      return { ok: true, reclaimed: await reclaimWorktrees(f.rootA, f.storeA, 1) };
    });
    expect(seen.response).toEqual({ ok: false, code: 'not_found', message: 'not found in this project' });
    expect(seen.audit).toEqual([{ check: 'sweep', code: 'not_found' }]);
    expect(seen.eventsA).toEqual([]);
  });

  // ---- the documented partial-success outcome ----------------------------------------------

  it('a mixed A/B bulk list: owned items proceed, the rest are refused by position, nothing echoes an id', async () => {
    const ids = [f.alphaBulk1.id, f.bravoRun.id, 'no-such-task', f.alphaBulk2.id, f.alphaBulk1.id, f.bravoRun.id];
    const seen = await attempt(async () => {
      const bulk = await partitionOwned(scope, 'run', ids, ownRun);
      for (const { value } of bulk.allowed) f.storeA.setArchived(value.id, true);
      return { outcome: bulk.outcome, allowed: bulk.allowed.map((a) => a.index), refused: bulk.refused };
    });
    expect(seen.response).toEqual({
      outcome: 'partial',
      allowed: [0, 3],
      refused: [
        { index: 1, code: 'not_found' },
        { index: 2, code: 'not_found' },
        { index: 4, code: 'duplicate' },
        { index: 5, code: 'not_found' },
      ],
    });
    // A foreign id and an id that exists nowhere read identically (N-01).
    expect(seen.audit).toEqual([
      { check: 'run', code: 'not_found', index: 1 },
      { check: 'run', code: 'not_found', index: 2 },
      { check: 'run', code: 'duplicate', index: 4 },
      { check: 'run', code: 'not_found', index: 5 },
    ]);
    // Exactly the two owned runs changed, each once.
    expect(seen.eventsA.map((e) => (e as { payload: RunRecord }).payload.id)).toEqual([f.alphaBulk1.id, f.alphaBulk2.id]);
    expect(f.storeA.getRun(f.alphaBulk1.id)?.archived).toBe(true);
    expect(f.storeA.getRun(f.alphaBulk2.id)?.archived).toBe(true);
    f.storeA.setArchived(f.alphaBulk1.id, false);
    f.storeA.setArchived(f.alphaBulk2.id, false);
  });

  it('a bulk list: all owned → `all`; every element refused → `none`; nothing supplied → `empty`', async () => {
    const seen = await attempt(async () => ({
      all: await partitionOwned(scope, 'run', [f.alphaBulk1.id, f.alphaBulk2.id], ownRun),
      none: await partitionOwned(scope, 'run', [f.bravoRun.id, 'no-such-task'], ownRun),
      empty: await partitionOwned(scope, 'run', [], ownRun),
    }));
    const r = seen.response as Record<'all' | 'none' | 'empty', Awaited<ReturnType<typeof partitionOwned>>>;
    expect(r.all.outcome).toBe('all');
    expect(r.all.refused).toEqual([]);
    expect(r.none).toEqual({ outcome: 'none', allowed: [], refused: [{ index: 0, code: 'not_found' }, { index: 1, code: 'not_found' }] });
    // Empty input must not read like "everything was refused" — the two are different answers.
    expect(r.empty).toEqual({ outcome: 'empty', allowed: [], refused: [] });
    expect(r.empty.outcome).not.toBe(r.none.outcome);
  });

  it('archive-finished and read-all sweep only the bound project', async () => {
    const seen = await attempt(async () => {
      const archive = await ownSweep(scope, 'archive-finished');
      const read = await ownSweep(scope, 'read-all');
      return {
        archive: archive.ok ? f.storeA.archiveFinished() : archive,
        read: read.ok ? f.storeA.markAllRead() : read,
      };
    });
    expect(seen.response).toEqual({ archive: expect.any(Number), read: expect.any(Number) });
    expect((seen.response as { archive: number }).archive).toBeGreaterThan(0);
    expect(seen.audit).toEqual([]);
    for (const run of f.storeA.listRuns()) {
      if (run.archived && run.id !== f.alphaStray.id) f.storeA.setArchived(run.id, false);
    }
  });

  // ---- controls: the guard refuses the foreign, not everything ------------------------------

  it('admits the bound project’s own resources and hands the service a normalized path', async () => {
    expect(ownRun(scope, f.alphaRun.id)).toMatchObject({ ok: true, value: { id: f.alphaRun.id } });
    expect(ownQueuedMessage(scope, f.alphaRun.id, 'msg-alpha-1')).toMatchObject({ ok: true, value: { message: { id: 'msg-alpha-1' } } });
    expect(await ownGroup(scope, 'group-alpha')).toMatchObject({ ok: true, value: { runs: [{ id: f.alphaVariantA.id }, { id: f.alphaVariantB.id }] } });
    expect(await ownGroupMember(scope, 'group-alpha', f.alphaVariantB.id)).toMatchObject({ ok: true, value: { run: { id: f.alphaVariantB.id } } });
    expect(await ownWorktree(scope, f.alphaRun.id)).toEqual({ ok: true, value: expect.objectContaining({ path: f.alphaWorktree }) });

    const file = await fileFlow(f.alphaRun.id, './sub//deep.txt');
    expect(file).toMatchObject({ ok: true, result: { kind: 'file', path: 'sub/deep.txt', content: 'alpha deep\n' } });
    const listing = await fileFlow(f.alphaRun.id, '');
    expect(listing).toMatchObject({ ok: true, result: { kind: 'dir' } });
    expect(await ownWorktreeFile(scope, f.alphaRun.id, 'missing.txt')).toMatchObject({ ok: false, code: 'not_found' });

    expect(ownAutomation(scope, f.alphaAutomation.id)).toMatchObject({ ok: true });
    expect(ownAutomationReceipt(scope, f.alphaReceipt.receiptId)).toMatchObject({ ok: true, value: { receiptId: f.alphaReceipt.receiptId } });
    expect(checkFlow(f.alphaCheck.id)).toEqual({ ok: true, value: f.alphaCheck });
    expect(await ownWorkflow(scope, 'quick-task')).toMatchObject({ ok: true, value: { name: 'quick-task' } });

    const cursor = sealCursor(scope, `run:${f.alphaRun.id}:history`, 'page-2');
    expect(cursorFlow(`run:${f.alphaRun.id}:history`, cursor)).toEqual({ ok: true, value: 'page-2' });
    expect(await ownSweep(ownershipScope({ root: f.rootB, store: f.storeB, automationStore: f.autoStoreB }), 'reclaim-worktrees')).toEqual({ ok: true, value: 'reclaim-worktrees' });
    expect(audit).toEqual([{ check: 'file', code: 'not_found' }]);
  });

  it('binds to the project, not to the spelling of its root (the `default` alias problem)', () => {
    const alias = join(f.base, 'alpha-alias');
    symlinkSync(f.rootA, alias);
    const aliased = ownershipScope({ root: alias, store: f.storeA, automationStore: f.autoStoreA });
    expect(aliased.root).toBe(scope.root);
    const cursor = sealCursor(aliased, 'tasks', 'p2');
    expect(openCursor(scope, 'tasks', cursor)).toEqual({ ok: true, value: 'p2' });
    expect(ownAutomationCheck(aliased, f.alphaCheck.id, f.checks)).toMatchObject({ ok: true });
  });

  // ---- absent and malformed input: refused, never passed through ---------------------------

  it('refuses absent, empty, malformed and oversized identifiers', async () => {
    for (const bad of [undefined, null, '', 42, {}, 'x'.repeat(257), 'a\0b']) {
      expect(ownRun(scope, bad)).toMatchObject({ ok: false, code: 'not_found' });
      expect(await ownGroup(scope, bad)).toMatchObject({ ok: false, code: 'not_found' });
      expect(ownAutomationCheck(scope, bad, f.checks)).toMatchObject({ ok: false, code: 'not_found' });
      expect(ownQueuedMessage(scope, f.alphaRun.id, bad)).toMatchObject({ ok: false, code: 'not_found' });
      expect(await ownWorkflow(scope, bad)).toMatchObject({ ok: false, code: 'not_found' });
    }
    // An empty check map is "nothing to own", not "no restriction".
    expect(ownAutomationCheck(scope, f.alphaCheck.id, new Map())).toMatchObject({ ok: false, code: 'not_found' });
    expect(await ownWorkflow(scope, '../quick-task')).toMatchObject({ ok: false, code: 'not_found' });
    expect(await ownWorktreeFile(scope, f.alphaRun.id, 7)).toMatchObject({ ok: false, code: 'forbidden_path' });
    expect(await ownWorktreeFile(scope, f.alphaRun.id, 'x'.repeat(4_097))).toMatchObject({ ok: false, code: 'forbidden_path' });
    expect(await ownWorktreeFile(scope, f.alphaRun.id, 'C:/Windows')).toMatchObject({ ok: false, code: 'forbidden_path' });
    expect(await ownWorktreeFile(scope, f.alphaRun.id, 'notes.txt/child')).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('refuses a malformed, tampered or oversized cursor, and never seals past B-04', () => {
    const resource = `run:${f.alphaRun.id}:history`;
    const good = sealCursor(scope, resource, 'page-2');
    const decoded = JSON.parse(Buffer.from(good, 'base64url').toString('utf8')) as { v: 1; c: string; t: string };
    const tampered = Buffer.from(JSON.stringify({ ...decoded, c: 'page-9' })).toString('base64url');
    const extraKey = Buffer.from(JSON.stringify({ ...decoded, p: 'x' })).toString('base64url');
    for (const bad of [undefined, '', 'not-base64-json', tampered, extraKey, 'a'.repeat(MCP_CURSOR_MAX_BYTES + 1), 42]) {
      expect(openCursor(scope, resource, bad)).toMatchObject({ ok: false, code: 'invalid_cursor' });
    }
    expect(() => sealCursor(scope, resource, 'x'.repeat(MCP_CURSOR_MAX_BYTES))).toThrow(RangeError);
  });

  it('a throwing audit sink cannot turn a refusal into a pass', () => {
    const loud = ownershipScope({ root: f.rootA, store: f.storeA, automationStore: f.autoStoreA }, () => {
      throw new Error('sink down');
    });
    expect(ownRun(loud, f.bravoRun.id)).toMatchObject({ ok: false, code: 'not_found' });
  });
});

/**
 * The fixture is not inert. Without the guard, the SAME services, called with the SAME hostile
 * records, reach BRAVO: the files route serves BRAVO's secret through a symlinked worktree root,
 * and removing the worktree a stray record names deletes BRAVO's worktree — which the reclaim
 * sweep and the variant pick both did before #288 proved the path first. This is what the cases
 * above prevent, and it keeps them honest — a fixture that could not hurt BRAVO would pass them
 * vacuously.
 */
describe('resource ownership (#88) — the same flows without the guard', () => {
  it('reach project B', async () => {
    const f = buildFixture();
    try {
      const leaked = await readWorktreePath(worktreePathFor(f.rootA, f.alphaLinked.id), 'secret.txt');
      expect(leaked).toMatchObject({ kind: 'file', content: 'BRAVO-SECRET-CONTENT\n' });

      const before = bravoState(f);
      await removeWorktree(f.rootA, f.storeA.getRun(f.alphaStray.id)!.worktreePath!);
      expect(bravoState(f)).not.toBe(before);
      expect(() => lstatSync(join(f.bravoWorktree, 'secret.txt'))).toThrow();
    } finally {
      f.storeA.flush();
      f.storeB.flush();
      rmSync(f.base, { recursive: true, force: true });
    }
  }, 60_000);
});
