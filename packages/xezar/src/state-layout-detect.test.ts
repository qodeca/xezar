import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isLinkedWorktree, PROJECT_STATE_MARKER, resolveStateLayout } from './state-layout.ts';

/**
 * FR-1.3: a linked git worktree is never a single-project root, and the reason
 * is not tidiness. Every xezar task worktree under `.local/xezar/worktrees/` is
 * a linked worktree, so a mode that entered there would hand each running task
 * its own copy of the settings, accounts and registry the task is supposed to
 * be running against.
 *
 * These cases use a REAL `git worktree add` rather than a mocked `git`, because
 * what is being tested is a fact about git's own on-disk layout (`.git` is a
 * FILE in a linked worktree, and `--git-dir` differs from `--git-common-dir`),
 * and a mock would prove only that the mock agrees with the code (risk R3).
 */
describe('single-project detection against a real git worktree', () => {
  let base: string;
  let main: string;

  const git = (args: string[], cwd: string): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'xez test',
        GIT_AUTHOR_EMAIL: 'xez@example.invalid',
        GIT_COMMITTER_NAME: 'xez test',
        GIT_COMMITTER_EMAIL: 'xez@example.invalid',
      },
    });

  beforeEach(() => {
    base = mkdtempSync(join(realpathSync(tmpdir()), 'xez-detect-'));
    main = join(base, 'main');
    mkdirSync(main);
    git(['init', '--initial-branch=main', '.'], main);
    writeFileSync(join(main, 'README.md'), '# main\n', 'utf8');
    git(['add', 'README.md'], main);
    git(['commit', '-m', 'init'], main);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** Put the marker in a folder, the way a first `--single-project` run does. */
  const seedMarker = (dir: string): void => {
    mkdirSync(join(dir, '.xezar'), { recursive: true });
    writeFileSync(join(dir, '.xezar', PROJECT_STATE_MARKER), '{}\n', 'utf8');
  };

  it('reads a main checkout as NOT a linked worktree', () => {
    expect(isLinkedWorktree(main)).toBe(false);
  });

  it('reads a linked worktree as one', () => {
    const linked = join(base, 'linked');
    git(['worktree', 'add', linked, '-b', 'feature'], main);

    expect(isLinkedWorktree(linked)).toBe(true);
  });

  it('reads a folder that is not a repository at all as NOT a linked worktree', () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);

    expect(isLinkedWorktree(plain)).toBe(false);
  });

  it('enters the mode in the main checkout (SP-1.1)', () => {
    seedMarker(main);

    expect(resolveStateLayout(main, [], {}).mode).toBe('project');
  });

  it('does NOT enter the mode in a linked worktree, even with the flag (SP-1.2)', () => {
    const linked = join(base, 'linked');
    git(['worktree', 'add', linked, '-b', 'feature'], main);

    expect(resolveStateLayout(linked, ['--single-project'], {}).mode).toBe('global');
  });

  it('does NOT enter the mode in a linked worktree that carries the marker itself (SP-1.2)', () => {
    // The realistic shape: the marker is committed, so every worktree of that
    // repository has one. Git has to win over the file, or a single-project
    // repository could not run a single xezar task.
    const linked = join(base, 'linked');
    git(['worktree', 'add', linked, '-b', 'feature'], main);
    seedMarker(linked);

    expect(resolveStateLayout(linked, [], {}).mode).toBe('global');
  });

  it('does NOT enter the mode in a task worktree under .local/xezar/worktrees (SP-1.2)', () => {
    const worktree = join(main, '.local', 'xezar', 'worktrees', 'deadbeef');
    git(['worktree', 'add', worktree, '-b', 'xez/deadbeef'], main);
    seedMarker(worktree);

    expect(resolveStateLayout(worktree, ['--single-project'], {}).mode).toBe('global');
  });

  it('refuses the mode for a copied-out worktree whose git can no longer answer', () => {
    // A `.git` FILE with a dangling `gitdir:` — the conservative direction is
    // to refuse the mode, because entering it wrongly splits a task's state
    // while refusing it merely keeps today's behaviour.
    const orphan = join(base, 'orphan');
    mkdirSync(orphan);
    writeFileSync(join(orphan, '.git'), `gitdir: ${join(base, 'gone', '.git', 'worktrees', 'x')}\n`, 'utf8');
    seedMarker(orphan);

    expect(isLinkedWorktree(orphan)).toBe(true);
    expect(resolveStateLayout(orphan, [], {}).mode).toBe('global');
  });
});
