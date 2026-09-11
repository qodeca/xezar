import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { branchFor, createWorktree, removeWorktree as realRemove } from '../git-worktree.ts';
import { reclaimWorktrees, type RetentionStore } from './retention.ts';
import type { RunRecord } from './store.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixtureRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'xez-retention-'));
  roots.push(root);
  await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'base.txt'), 'base\n');
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
  return root;
}

async function branchExists(repo: string, runId: string): Promise<boolean> {
  const res = await run('git', ['show-ref', '--verify', `refs/heads/${branchFor(runId)}`], {
    cwd: repo,
  }).then(
    () => true,
    () => false,
  );
  return res;
}

/** A tiny in-memory store exposing only what the enforcer touches. */
function fakeStore(runs: RunRecord[]): RetentionStore & { runs: RunRecord[] } {
  return {
    runs,
    listRuns: () => runs,
    updateRun: (id, patch) => {
      const r = runs.find((x) => x.id === id);
      if (r) Object.assign(r, patch);
      return r;
    },
  };
}

function finishedRun(id: string, path: string, finishedAt: string): RunRecord {
  return {
    id,
    status: 'done',
    createdAt: finishedAt,
    finishedAt,
    worktreePath: path,
    steps: [],
  } as unknown as RunRecord;
}

describe('reclaimWorktrees (real git, #483)', () => {
  it('reclaims the oldest over-limit worktree: dir removed, branch kept, field stamped', async () => {
    const repo = await fixtureRepo();
    const oldId = '11111111-1111-4111-8111-111111111111';
    const newId = '22222222-2222-4222-8222-222222222222';
    const oldWt = await createWorktree(repo, oldId, 'main');
    const newWt = await createWorktree(repo, newId, 'main');

    const store = fakeStore([
      finishedRun(oldId, oldWt.path, '2026-07-01T00:00:00.000Z'),
      finishedRun(newId, newWt.path, '2026-07-09T00:00:00.000Z'),
    ]);

    const reclaimed = await reclaimWorktrees(repo, store, 1, {
      now: () => '2026-07-18T00:00:00.000Z',
    });

    expect(reclaimed).toEqual([oldId]);
    // Oldest: directory gone, branch preserved (recoverable), stamp written.
    expect(existsSync(oldWt.path)).toBe(false);
    expect(await branchExists(repo, oldId)).toBe(true);
    expect(store.runs.find((r) => r.id === oldId)?.worktreeReclaimedAt).toBe(
      '2026-07-18T00:00:00.000Z',
    );
    // Newest: untouched.
    expect(existsSync(newWt.path)).toBe(true);
    expect(store.runs.find((r) => r.id === newId)?.worktreeReclaimedAt).toBeUndefined();
  });

  it('does not stamp a run whose directory still exists after a no-op remove (retries next pass)', async () => {
    const repo = await fixtureRepo();
    const oldId = '44444444-4444-4444-8444-444444444444';
    const newId = '55555555-5555-4555-8555-555555555555';
    const oldWt = await createWorktree(repo, oldId, 'main');
    const newWt = await createWorktree(repo, newId, 'main');
    const store = fakeStore([
      finishedRun(oldId, oldWt.path, '2026-07-01T00:00:00.000Z'),
      finishedRun(newId, newWt.path, '2026-07-09T00:00:00.000Z'),
    ]);

    const reclaimed = await reclaimWorktrees(repo, store, 1, {
      remove: async () => {
        /* pretend removal failed: dir stays */
      },
    });

    expect(reclaimed).toEqual([]);
    expect(existsSync(oldWt.path)).toBe(true);
    expect(store.runs.find((r) => r.id === oldId)?.worktreeReclaimedAt).toBeUndefined();
  });

  // REGRESSION (#200). The caller's "am I still alive" check used to sit only BEFORE the call, so
  // it stopped a sweep before its first removal and never again — a multi-worktree pass that
  // straddled a `RunManager.dispose()` went on spawning git and stamping records inside a data
  // root its owner had finished with. Four worktrees, three of them over the keep-limit, and a
  // `shouldStop` that flips after the first removal: without the per-iteration check all three go.
  it('stops mid-sweep when shouldStop flips, and reports only what it reclaimed', async () => {
    const repo = await fixtureRepo();
    const ids = [
      '77777777-7777-4777-8777-777777777777',
      '88888888-8888-4888-8888-888888888888',
      '99999999-9999-4999-8999-999999999999',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ];
    const paths: string[] = [];
    for (const id of ids) paths.push((await createWorktree(repo, id, 'main')).path);
    const store = fakeStore(
      ids.map((id, index) => finishedRun(id, paths[index]!, `2026-07-0${index + 1}T00:00:00.000Z`)),
    );

    let removals = 0;
    const reclaimed = await reclaimWorktrees(repo, store, 1, {
      now: () => '2026-07-18T00:00:00.000Z',
      shouldStop: () => removals >= 1,
      remove: async (root, path) => {
        removals += 1;
        await realRemove(root, path);
      },
    });

    expect(reclaimed).toHaveLength(1);
    expect(removals).toBe(1);
    // The ones it never reached are untouched — no directory removed, no stamp written, so the
    // next owner's sweep still sees them as over-limit and reclaims them then.
    const untouched = ids.filter((id) => !reclaimed.includes(id));
    for (const id of untouched) {
      expect(store.runs.find((r) => r.id === id)?.worktreeReclaimedAt).toBeUndefined();
    }
    expect(paths.filter((path) => existsSync(path))).toHaveLength(3);
  });

  it('keep=0 reclaims nothing (unlimited)', async () => {
    const repo = await fixtureRepo();
    const id = '66666666-6666-4666-8666-666666666666';
    const wt = await createWorktree(repo, id, 'main');
    const store = fakeStore([finishedRun(id, wt.path, '2026-07-01T00:00:00.000Z')]);
    expect(await reclaimWorktrees(repo, store, 0)).toEqual([]);
    expect(existsSync(wt.path)).toBe(true);
  });
});
