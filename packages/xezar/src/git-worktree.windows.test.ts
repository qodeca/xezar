import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withPlatform } from '../test/helpers/platform.ts';
import { branchFor, createWorktree } from './git-worktree.ts';
import { withIdentityPlatform } from './platform/identity-platform.testkit.ts';
import { LONG_PATHS_FIX } from './platform/long-paths.ts';

/**
 * `createWorktree`'s Windows branches (#963) against a scripted `git`, so they run on every OS: the
 * identity compare of a registered worktree path (Git may spell it in another letter case) and the
 * long-path hint on a failed `git worktree add`. The real-git cases live in git-worktree.test.ts.
 *
 * The identity cases force only the identity rule (`withIdentityPlatform`): under a forced
 * `process.platform` a POSIX host's `/tmp/…` would also go through the Windows `fromGitPath` and
 * become `\tmp\…`, which is not what Git for Windows prints. The hint cases force the whole platform.
 */

interface GitReply {
  ok: boolean;
  stdout: string;
  stderr: string;
}

const gitHook = vi.hoisted(() => ({
  answer: (_args: readonly string[]): GitReply => ({ ok: true, stdout: '', stderr: '' }),
  calls: [] as string[][],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  type Callback = (error: Error | null, stdout: string, stderr: string) => void;
  const execFile = (file: string, args: string[], options: unknown, callback: Callback): unknown => {
    if (file !== 'git') return actual.execFile(file, args, options as never, callback as never);
    gitHook.calls.push(args);
    const reply = gitHook.answer(args);
    queueMicrotask(() => callback(reply.ok ? null : Object.assign(new Error('git failed'), { code: 128 }), reply.stdout, reply.stderr));
    return undefined;
  };
  return { ...actual, execFile };
});

vi.mock('./platform/path-identity.ts', async (importOriginal) =>
  (await import('./platform/identity-platform.testkit.ts')).identityModuleWith(await importOriginal()));

const RUN_ID = '55555555-5555-4555-8555-555555555555';
const BRANCH_REF = `refs/heads/${branchFor(RUN_ID)}`;
const TOO_LONG = "fatal: could not create leading directories of 'x': Filename too long";
const ok = (stdout = ''): GitReply => ({ ok: true, stdout, stderr: '' });
const failed = (stderr: string): GitReply => ({ ok: false, stdout: '', stderr });
const porcelain = (...rows: Array<[string, string]>): string =>
  rows.map(([path, branch]) => `worktree ${path}\nHEAD 0000000\nbranch ${branch}\n`).join('\n');
/** The git subcommand a call made: `worktree list`, `show-ref --verify`, … */
const subcommand = (args: readonly string[]): string => args.slice(0, 2).join(' ');

let repo: string;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'xez-worktree-win-')));
  gitHook.calls.length = 0;
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** The task worktree folder `createWorktree` aims at, created non-empty (uncommitted work in it). */
function existingTaskFolder(): string {
  const path = join(repo, '.local', 'xezar', 'worktrees', RUN_ID);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'work.txt'), 'uncommitted');
  return path;
}

describe('createWorktree – a registered path in another letter case is the same folder (#963 Q3)', () => {
  it('reuses the registered worktree at once, without a repair or a second add', async () => {
    const spelled = existingTaskFolder().toUpperCase();
    gitHook.answer = (args) => (subcommand(args) === 'worktree list' ? ok(porcelain([repo, 'refs/heads/main'], [spelled, BRANCH_REF])) : ok());
    const info = await withIdentityPlatform('win32', () => createWorktree(repo, RUN_ID, 'main'));
    expect(info).toEqual({ path: spelled, branch: branchFor(RUN_ID), baseBranch: 'main' });
    expect(gitHook.calls.map(subcommand)).toEqual(['worktree prune', 'worktree list']);
  });

  it('finds it after a repair when Git then lists it in another letter case', async () => {
    const spelled = existingTaskFolder().toUpperCase();
    let repaired = false;
    gitHook.answer = (args) => {
      if (subcommand(args) === 'worktree repair') repaired = true;
      if (subcommand(args) !== 'worktree list') return ok();
      return ok(repaired ? porcelain([repo, 'refs/heads/main'], [spelled, BRANCH_REF]) : porcelain([repo, 'refs/heads/main']));
    };
    const info = await withIdentityPlatform('win32', () => createWorktree(repo, RUN_ID, 'main'));
    expect(info.path).toBe(spelled);
    expect(gitHook.calls.map(subcommand)).toEqual(['worktree prune', 'worktree list', 'worktree repair', 'worktree list']);
  });
});

describe('createWorktree – "Filename too long" carries the long-path fix on Windows only (#963)', () => {
  /** No registered worktree and no folder; `show-ref` says whether the task branch exists. */
  function scriptAddFailure(branchExists: boolean): void {
    gitHook.answer = (args) => {
      if (subcommand(args) === 'worktree list') return ok();
      if (args[0] === 'show-ref') return branchExists ? ok() : failed('');
      if (subcommand(args) === 'worktree add') return failed(`${TOO_LONG}\n`);
      return ok();
    };
  }

  it('appends the fix to a failed add on win32', async () => {
    scriptAddFailure(false);
    await expect(withPlatform('win32', () => createWorktree(repo, RUN_ID, 'main'))).rejects.toMatchObject({
      message: `git worktree add failed: ${TOO_LONG}. This path is too long for Windows; long file paths may be off. ${LONG_PATHS_FIX}`,
    });
  });

  it('appends the fix to a failed reattach of a surviving task branch on win32', async () => {
    scriptAddFailure(true);
    await expect(withPlatform('win32', () => createWorktree(repo, RUN_ID, 'main'))).rejects.toMatchObject({
      message: `git worktree reattach failed: ${TOO_LONG}. This path is too long for Windows; long file paths may be off. ${LONG_PATHS_FIX}`,
    });
  });

  it.each(['linux', 'darwin'] as const)('keeps the failure text exactly as Git printed it on %s', async (platform) => {
    for (const branchExists of [false, true]) {
      scriptAddFailure(branchExists);
      const error = await withPlatform(platform, () => createWorktree(repo, RUN_ID, 'main')).then(
        () => undefined,
        (caught: unknown) => caught as Error,
      );
      expect(error?.message).toBe(`git worktree ${branchExists ? 'reattach' : 'add'} failed: ${TOO_LONG}`);
    }
  });
});
