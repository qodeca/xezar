import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { branchFor, createWorktree, pruneOrphans } from './git-worktree.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const roots: string[] = [];

async function fixtureRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'xez-prune-'));
  roots.push(root);
  await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, '.gitignore'), '.local/\n');
  writeFileSync(join(root, 'base.txt'), 'base\n');
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
  return root;
}

async function branchExists(root: string, branch: string): Promise<boolean> {
  return run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: root }).then(
    () => true,
    () => false,
  );
}

const ID_A = '0a1b2c3d-1111-4222-8333-444455556666';
const ID_B = '1b2c3d4e-1111-4222-8333-444455556666';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('pruneOrphans never deletes work xezar has no record of', () => {
  it('keeps the folder AND the branch of an orphan with uncommitted changes, even against an empty store', async () => {
    const root = await fixtureRepo();
    const wt = await createWorktree(root, ID_A, 'main');
    writeFileSync(join(wt.path, 'base.txt'), 'unsaved agent edit\n');

    const sweep = await pruneOrphans(root, new Set());

    expect(sweep).toEqual({ removed: [], kept: [ID_A] });
    expect(existsSync(join(wt.path, 'base.txt'))).toBe(true);
    expect(await branchExists(root, branchFor(ID_A))).toBe(true);
  });

  it('keeps an orphan whose only change is an untracked file', async () => {
    const root = await fixtureRepo();
    const wt = await createWorktree(root, ID_A, 'main');
    writeFileSync(join(wt.path, 'new-file.txt'), 'new\n');

    const sweep = await pruneOrphans(root, new Set());

    expect(sweep.kept).toEqual([ID_A]);
    expect(existsSync(join(wt.path, 'new-file.txt'))).toBe(true);
  });

  it('reclaims only the folder of a clean orphan whose record was retired; its unmerged branch survives', async () => {
    const root = await fixtureRepo();
    const wt = await createWorktree(root, ID_A, 'main');
    writeFileSync(join(wt.path, 'work.txt'), 'committed agent work\n');
    await run('git', ['add', '-A'], { cwd: wt.path });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'agent work'], { cwd: wt.path });

    const sweep = await pruneOrphans(root, new Set());

    expect(sweep).toEqual({ removed: [ID_A], kept: [] });
    expect(existsSync(wt.path)).toBe(false);
    expect(await branchExists(root, branchFor(ID_A))).toBe(true);
    const log = await run('git', ['log', '--format=%s', branchFor(ID_A)], { cwd: root });
    expect(log.stdout).toContain('agent work');
  });

  it('keeps a clean orphan on a detached HEAD (its commits may be on no branch)', async () => {
    const root = await fixtureRepo();
    const wt = await createWorktree(root, ID_A, 'main');
    await run('git', ['checkout', '-q', '--detach'], { cwd: wt.path });

    const sweep = await pruneOrphans(root, new Set());

    expect(sweep.kept).toEqual([ID_A]);
    expect(existsSync(wt.path)).toBe(true);
  });

  it('never touches a folder git does not know as a worktree, nor one that is not a run id', async () => {
    const root = await fixtureRepo();
    const worktrees = join(root, '.local', 'xezar', 'worktrees');
    mkdirSync(join(worktrees, ID_A), { recursive: true });
    writeFileSync(join(worktrees, ID_A, 'notes.txt'), 'hand-made\n');
    await createWorktree(root, ID_B, 'main');
    await run('git', ['worktree', 'add', '-q', '-b', 'manual', join(worktrees, 'manual-checkout')], { cwd: root });

    const sweep = await pruneOrphans(root, new Set([ID_B]));

    expect(sweep).toEqual({ removed: [], kept: [ID_A] });
    expect(existsSync(join(worktrees, ID_A, 'notes.txt'))).toBe(true);
    expect(existsSync(join(worktrees, ID_B))).toBe(true);
    expect(existsSync(join(worktrees, 'manual-checkout'))).toBe(true);
  });
});
