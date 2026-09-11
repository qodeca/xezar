import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PROJECT_A, PROJECT_B, createAbWorld, nowhereId, type AbWorld } from '../../test/helpers/ab-fixture.ts';
import { branchFor, worktreePathFor } from '../git-worktree.ts';
import { reclaimWorktrees } from '../runs/retention.ts';

/**
 * The cockpit's own routes and another project's resources (#288).
 *
 * Two different questions, and the cases below keep them apart:
 *
 *  1. Can a caller NAME project B's group, task or automation at project A's door? No, and nothing
 *     here changes that: every project route resolves its id in the bound project's own store
 *     (`resolveProjectScope` hands each route one project's `store` / `automationStore`), so a B id
 *     at A's door is exactly as unknown as an id that exists nowhere. These are GUARDS: they pass
 *     with and without the fix, and they pin what must not change.
 *
 *  2. Can an A RECORD that already names B's directory — the shape a copied or hand-edited
 *     `.local/xezar` produces (`hostile` in the A/B fixture) — make A's routes change B? Before the
 *     fix, yes: the variant pick and the worktree reclaim `rm -rf` whatever path the record names,
 *     and the group read runs `git add -N .` inside it. Those cases fail without the fix.
 *
 * What is NOT a boundary, and why the Files tab is not guarded: the cockpit API is unauthenticated
 * and multi-project by design, so B's files are served at B's own door to the same caller (the
 * last control below). A read through A's door crosses nothing that B's door does not already open.
 */

const A = `/api/v1/p/${PROJECT_A}`;
const B = `/api/v1/p/${PROJECT_B}`;

async function answer(res: Response): Promise<{ status: number; body: string }> {
  return { status: res.status, body: await res.text() };
}

/** B's worktree git index — what `git add -N .` inside B's worktree would rewrite. */
const bIndex = (w: AbWorld): string => join(w.b.root, '.git', 'worktrees', basename(w.b.worktree), 'index');

/** Nothing that identifies B — its root, its worktree, its file words, its ids or names. */
function namesNothingOfB(w: AbWorld, body: string): void {
  for (const secret of [w.b.root, w.b.worktree, w.b.fileContent, w.b.ids.done, w.b.ids.group, ...w.b.names]) {
    expect(body).not.toContain(secret);
  }
}

describe.skipIf(process.platform === 'win32')('cockpit routes and another project’s resources (#288)', { timeout: 120_000 }, () => {
  let world: AbWorld | undefined;
  beforeEach(async () => {
    world = await createAbWorld({ sockets: false, hostile: true, automations: true });
  }, 60_000);
  afterEach(async () => {
    await world?.dispose();
    world = undefined;
  }, 60_000);
  const w = (): AbWorld => world!;

  // ---- guards: pass with and without the fix ---------------------------------------------------

  it('naming B’s group, task or automation at A’s door answers exactly like an id that exists nowhere', async () => {
    const nowhere = nowhereId();
    const before = w().snapshot('b');
    const pairs: Array<[string, string, string, unknown, unknown]> = [
      ['GET', `${A}/groups/${w().b.ids.group}`, `${A}/groups/g-${nowhere}`, undefined, undefined],
      ['POST', `${A}/groups/${w().b.ids.group}/pick`, `${A}/groups/g-${nowhere}/pick`, { runId: w().b.ids.variants[0] }, { runId: nowhere }],
      ['GET', `${A}/runs/${w().b.ids.done}/files?path=notes.txt`, `${A}/runs/${nowhere}/files?path=notes.txt`, undefined, undefined],
      ['POST', `${A}/automations/${w().b.ids.automation}/check`, `${A}/automations/${nowhere}/check`, { mode: 'preview' }, { mode: 'preview' }],
    ];
    for (const [method, foreign, unknown, foreignBody, unknownBody] of pairs) {
      const b = await answer(await w().cockpit(foreign, method, foreignBody));
      const n = await answer(await w().cockpit(unknown, method, unknownBody));
      expect(b.status, foreign).toBe(404);
      expect(b, foreign).toEqual(n);
      namesNothingOfB(w(), b.body);
    }
    expect(w().snapshot('b')).toBe(before);
  });

  it('A’s own group, task files and reclaim keep working (the doors are not simply shut)', async () => {
    const group = await answer(await w().cockpit(`${A}/groups/${w().a.ids.group}`));
    expect(group.status).toBe(200);
    expect(JSON.parse(group.body).runs.map((r: { id: string }) => r.id)).toEqual(w().a.ids.variants);
    const file = await answer(await w().cockpit(`${A}/runs/${w().a.ids.done}/files?path=notes.txt`));
    expect(file.status).toBe(200);
    expect(JSON.parse(file.body).content).toContain(w().a.fileContent);
  });

  it('control: B’s files are served at B’s own door to the same caller — no guard on A’s door can hide them', async () => {
    const file = await answer(await w().cockpit(`${B}/runs/${w().b.ids.done}/files?path=notes.txt`));
    expect(file.status).toBe(200);
    expect(JSON.parse(file.body).content).toContain(w().b.fileContent);
  });

  // ---- regressions: fail without the fix ----------------------------------------------------------

  it('a group with a member that reaches into B is not A’s group: the read refuses it whole and runs no git in B', async () => {
    const h = w().hostile!;
    const nowhere = nowhereId();
    const before = w().snapshot('b');
    const indexBefore = readFileSync(bIndex(w()), null);
    const mixed = await answer(await w().cockpit(`${A}/groups/${h.mixedGroup}`));
    const unknown = await answer(await w().cockpit(`${A}/groups/g-${nowhere}`));
    expect(readFileSync(bIndex(w()), null).equals(indexBefore), 'git ran inside B’s worktree and rewrote its index').toBe(true);
    namesNothingOfB(w(), mixed.body);
    expect(mixed.status).toBe(404);
    expect(mixed.body).toBe(unknown.body);
    expect(w().snapshot('b')).toBe(before);
  });

  it('picking a variant of that group deletes nothing of B and changes nothing of A', async () => {
    const h = w().hostile!;
    const nowhere = nowhereId();
    const before = w().snapshot('b');
    const picked = await answer(await w().cockpit(`${A}/groups/${h.mixedGroup}/pick`, 'POST', { runId: h.legit }));
    const unknown = await answer(await w().cockpit(`${A}/groups/g-${nowhere}/pick`, 'POST', { runId: nowhere }));
    // B's worktree — which the stray A record names — is still there, byte for byte.
    expect(existsSync(join(w().b.worktree, 'notes.txt')), 'B’s worktree was deleted').toBe(true);
    expect(w().snapshot('b')).toBe(before);
    expect(picked.status).toBe(404);
    expect(picked.body).toBe(unknown.body);
    namesNothingOfB(w(), picked.body);
    // Nothing of A was picked, archived or stripped of its worktree either.
    expect(w().a.store.getRun(h.stray)?.worktreePath).toBe(w().b.worktree);
    for (const id of [h.legit, h.stray]) expect(w().a.store.getRun(id)?.archived ?? false).toBe(false);
  });

  it('reclaim — through the route and through the shared enforcer — never deletes a directory an A record names outside A', async () => {
    const a = w().a;
    const h = w().hostile!;
    // One more finished A task with a real worktree at A's own path, older than everything else,
    // so a keep-limit of 1 has an A worktree to reclaim: the control that reclaim still works.
    const old = a.store.createRun({ title: 'ALPHA old task', workflow: 'quick-task', task: 'ALPHA old', steps: [] });
    const oldPath = worktreePathFor(a.root, old.id);
    execFileSync('git', ['worktree', 'add', '-q', '-b', branchFor(old.id), oldPath], { cwd: a.root, stdio: 'ignore' });
    a.store.updateRun(old.id, { status: 'done', finishedAt: '2026-07-01T00:00:00.000Z', worktreePath: oldPath, branch: branchFor(old.id) });
    writeFileSync(join(a.root, '.xezar', 'config.json'), JSON.stringify({ skillsRepos: [], worktreeRetention: 1 }), 'utf8');

    const before = w().snapshot('b');
    const res = await answer(await w().cockpit(`${A}/worktrees/reclaim`, 'POST', {}));
    expect(existsSync(join(w().b.worktree, 'notes.txt')), 'B’s worktree was deleted').toBe(true);
    expect(res.status).toBe(200);
    const { reclaimed } = JSON.parse(res.body) as { reclaimed: string[] };
    expect(reclaimed).toContain(old.id);
    expect(reclaimed).not.toContain(h.stray);
    expect(reclaimed).not.toContain(h.linked);
    expect(existsSync(oldPath)).toBe(false);
    expect(w().snapshot('b')).toBe(before);
    expect(a.store.getRun(h.stray)?.worktreeReclaimedAt).toBeUndefined();

    // The automatic sweeps (boot, project open, every task's end) call the same enforcer.
    const again = await reclaimWorktrees(a.root, a.store, 1);
    expect(again).not.toContain(h.stray);
    expect(existsSync(join(w().b.worktree, 'notes.txt'))).toBe(true);
    expect(w().snapshot('b')).toBe(before);
  });
});

/**
 * The seven run routes #293 left (#316). Each one runs git in, pushes from or deletes the worktree
 * its run record names, and the record is data: `stray` names B's worktree outright and `linked`
 * sits at A's own path as a symlink into B. For every route there are two cases — the REGRESSION
 * (either record is refused exactly like an id that exists nowhere, and B is unchanged byte for
 * byte) and the CONTROL (A's own finished task still gets the real effect). The controls pass
 * with and without the fix; the regressions fail without it.
 */
describe.skipIf(process.platform === 'win32')('run routes and a record that names another project’s worktree (#316)', { timeout: 120_000 }, () => {
  let world: AbWorld | undefined;
  let bare: string | undefined;
  beforeEach(async () => {
    world = await createAbWorld({ sockets: false, hostile: true });
  }, 60_000);
  afterEach(async () => {
    await world?.dispose();
    world = undefined;
    if (bare) rmSync(bare, { recursive: true, force: true });
    bare = undefined;
  }, 60_000);
  const w = (): AbWorld => world!;

  /** A bare `origin` for `side`, outside both roots, so a push has somewhere real to land. */
  const withOrigin = (side: 'a' | 'b'): string => {
    bare = realpathSync(mkdtempSync(join(tmpdir(), 'xez-316-origin-')));
    execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: w()[side].root, stdio: 'ignore' });
    return bare;
  };
  const refsOf = (repo: string): string => execFileSync('git', ['for-each-ref'], { cwd: repo, encoding: 'utf8' });
  const bWorktreeIntact = (): void => {
    expect(existsSync(join(w().b.worktree, 'notes.txt')), 'B’s worktree was deleted').toBe(true);
  };

  interface RouteCase {
    name: string;
    method: string;
    path: (id: string) => string;
    body?: unknown;
  }
  const routes: Record<string, RouteCase> = {
    delete: { name: 'DELETE /runs/:id', method: 'DELETE', path: (id) => `${A}/runs/${id}` },
    removeWorktree: { name: 'POST /runs/:id/remove-worktree', method: 'POST', path: (id) => `${A}/runs/${id}/remove-worktree`, body: {} },
    commit: { name: 'POST /runs/:id/git/commit', method: 'POST', path: (id) => `${A}/runs/${id}/git/commit`, body: { message: 'owned?' } },
    push: { name: 'POST /runs/:id/git/push', method: 'POST', path: (id) => `${A}/runs/${id}/git/push`, body: {} },
    pr: { name: 'POST /runs/:id/pr', method: 'POST', path: (id) => `${A}/runs/${id}/pr`, body: {} },
    diff: { name: 'GET /runs/:id/diff', method: 'GET', path: (id) => `${A}/runs/${id}/diff` },
    changes: { name: 'GET /runs/:id/changes', method: 'GET', path: (id) => `${A}/runs/${id}/changes` },
  };

  /**
   * Both hostile records at `route`: nothing of B moves, and the refusal says in plain words why
   * and what to do (the cockpit shows the server's `error` as is — a bare "not found" on a row the
   * user can see would be a dead end). An id A does not hold at all stays the plain 404.
   */
  async function refusesBoth(route: RouteCase): Promise<void> {
    const h = w().hostile!;
    const before = w().snapshot('b');
    const indexBefore = readFileSync(bIndex(w()), null);
    const unknown = await answer(await w().cockpit(route.path(nowhereId()), route.method, route.body));
    expect(unknown).toEqual({ status: 404, body: JSON.stringify({ error: 'not found' }) });
    for (const id of [h.stray, h.linked]) {
      const res = await answer(await w().cockpit(route.path(id), route.method, route.body));
      bWorktreeIntact();
      expect(readFileSync(bIndex(w()), null).equals(indexBefore), `${route.name} ran git inside B’s worktree`).toBe(true);
      expect(w().snapshot('b'), `${route.name} changed B`).toBe(before);
      expect(res.status, `${route.name} with ${id === h.stray ? 'stray' : 'linked'}`).toBe(409);
      const { error } = JSON.parse(res.body) as { error: string };
      expect(error).toMatch(/^This task's worktree is outside this project/);
      expect(error).toMatch(/Archive the task/);
      namesNothingOfB(w(), res.body);
      // The A record itself is left as it was: not deleted, not stripped, not finished by a PR.
      expect(w().a.store.getRun(id)).toBeDefined();
      expect(w().a.store.getRun(id)?.worktreePath).toBeDefined();
      expect(w().a.store.getRun(id)?.pullRequestUrl).toBeUndefined();
    }
  }

  // ---- DELETE /runs/:id (rm -rf) -----------------------------------------------------------------

  it('DELETE refuses a record naming B’s worktree, and B’s directory is still there afterwards', async () => {
    await refusesBoth(routes.delete!);
    // The way out the refusal names really works: archiving moves the row out of the list and
    // still touches nothing of B.
    const before = w().snapshot('b');
    for (const id of [w().hostile!.stray, w().hostile!.linked]) {
      expect((await w().cockpit(`${A}/runs/${id}/archive`, 'POST', {})).status).toBe(200);
      expect(w().a.store.getRun(id)?.archived).toBe(true);
    }
    bWorktreeIntact();
    expect(w().snapshot('b')).toBe(before);
  });

  it('control: DELETE still deletes A’s own task with its worktree, and one that never had a worktree', async () => {
    const a = w().a;
    const res = await answer(await w().cockpit(routes.delete!.path(a.ids.done), 'DELETE'));
    expect(res).toEqual({ status: 200, body: JSON.stringify({ deleted: true }) });
    expect(existsSync(a.worktree)).toBe(false);
    expect(a.store.getRun(a.ids.done)).toBeUndefined();
    const plain = await answer(await w().cockpit(routes.delete!.path(w().hostile!.legit), 'DELETE'));
    expect(plain.status).toBe(200);
  });

  // ---- POST /runs/:id/remove-worktree (rm -rf) ---------------------------------------------------

  it('remove-worktree refuses a record naming B’s worktree, and B’s directory is still there afterwards', async () => {
    await refusesBoth(routes.removeWorktree!);
  });

  it('control: remove-worktree still removes A’s own worktree', async () => {
    const a = w().a;
    const res = await answer(await w().cockpit(routes.removeWorktree!.path(a.ids.done), 'POST', {}));
    expect(res).toEqual({ status: 200, body: JSON.stringify({ removed: true }) });
    expect(existsSync(a.worktree)).toBe(false);
    expect(a.store.getRun(a.ids.done)?.worktreePath).toBeUndefined();
  });

  // ---- POST /runs/:id/git/commit -------------------------------------------------------------------

  it('git/commit refuses a record naming B’s worktree and commits nothing in B', async () => {
    await refusesBoth(routes.commit!);
  });

  it('control: git/commit still commits A’s own worktree', async () => {
    const a = w().a;
    const res = await answer(await w().cockpit(routes.commit!.path(a.ids.done), 'POST', { message: 'owned?' }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ committed: true });
    expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: a.worktree, encoding: 'utf8' }).trim()).toBe('owned?');
  });

  // ---- POST /runs/:id/git/push ---------------------------------------------------------------------

  it('git/push refuses a record naming B’s worktree and pushes nothing to B’s remote', async () => {
    const origin = withOrigin('b');
    await refusesBoth(routes.push!);
    expect(refsOf(origin)).toBe('');
  });

  it('control: git/push still pushes A’s own branch', async () => {
    const a = w().a;
    const origin = withOrigin('a');
    const res = await answer(await w().cockpit(routes.push!.path(a.ids.done), 'POST', {}));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ pushed: true, branch: branchFor(a.ids.done) });
    expect(refsOf(origin)).toContain(branchFor(a.ids.done));
  });

  // ---- POST /runs/:id/pr ---------------------------------------------------------------------------

  it('pr refuses a record naming B’s worktree and makes no pre-PR commit in B', async () => {
    await refusesBoth(routes.pr!);
  });

  it('control: pr still opens A’s own draft PR (dry run), with its pre-PR autosave', async () => {
    const a = w().a;
    const res = await answer(await w().cockpit(routes.pr!.path(a.ids.done), 'POST', {}));
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body)).toMatchObject({ dryRun: true });
    expect(a.store.getRun(a.ids.done)?.pullRequestUrl).toBeDefined();
  });

  // ---- GET /runs/:id/diff --------------------------------------------------------------------------

  it('diff refuses a record naming B’s worktree and runs no git in B', async () => {
    await refusesBoth(routes.diff!);
  });

  it('control: diff still answers A’s own worktree diff', async () => {
    const a = w().a;
    const res = await answer(await w().cockpit(routes.diff!.path(a.ids.done)));
    expect(res.status).toBe(200);
    expect(res.body).toContain(a.fileContent);
  });

  // ---- GET /runs/:id/changes -----------------------------------------------------------------------

  it('changes refuses a record naming B’s worktree and runs no git in B', async () => {
    await refusesBoth(routes.changes!);
  });

  it('control: changes still answers A’s own worktree changes', async () => {
    const a = w().a;
    const res = await answer(await w().cockpit(routes.changes!.path(a.ids.done)));
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { files: Array<{ path: string }> };
    expect(body.files.map((f) => f.path)).toContain('notes.txt');
  });
});
