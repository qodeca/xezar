import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getBranches,
  getCommit,
  getDiff,
  getHeadCommit,
  getLog,
  getRepoInfo,
  getStatus,
} from './git.ts';

/**
 * getRepoInfo remote discovery: the forge seam (and so the GitHub tab) hangs
 * off `repo.remote`, so it must be found for HTTPS and SSH URLs alike, and for
 * repos whose only remote is NOT named `origin` (a plain `git remote get-url
 * origin` fails there). Genuinely remote-less repos still report no remote.
 */

function g(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/** A fixed identity, so every fixture commit works on a bare CI machine. */
const GIT_ID = ['-c', 'user.email=t@test', '-c', 'user.name=t'];

/** Every fixture directory this file creates, removed after each test. */
const scratch: string[] = [];

/**
 * A fresh temporary directory, resolved through `realpath`. macOS hands out
 * `/var/folders/...`, which is a symlink to `/private/var/folders/...`; git
 * always answers with the resolved path, so a test that compared raw
 * `mkdtemp` output against `rev-parse --show-toplevel` would fail there and
 * pass on Linux.
 */
function scratchDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

function initRepo(prefix = 'xez-git-shape-'): string {
  const dir = scratchDir(prefix);
  g(dir, 'init', '-q', '-b', 'main');
  return dir;
}

function commit(dir: string, message: string): string {
  g(dir, ...GIT_ID, 'commit', '--allow-empty', '-q', '-m', message);
  return g(dir, 'rev-parse', 'HEAD').trim();
}

afterEach(() => {
  // `maxRetries` is the point: git detaches background maintenance after a
  // commit, so a fixture's `.git` can still gain files while the removal walks
  // it, and the rmdir fails with ENOTEMPTY.
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('getRepoInfo — remote discovery', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xez-git-'));
    g(dir, 'init', '-q', '-b', 'main');
    g(dir, '-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads an HTTPS origin remote', async () => {
    g(dir, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
    const info = await getRepoInfo(dir);
    expect(info?.remote).toBe('https://github.com/acme/demo.git');
  });

  it('reads an SSH (scp-like) origin remote', async () => {
    g(dir, 'remote', 'add', 'origin', 'git@github.com:acme/demo.git');
    const info = await getRepoInfo(dir);
    expect(info?.remote).toBe('git@github.com:acme/demo.git');
  });

  it('falls back to the first configured remote when none is named origin', async () => {
    g(dir, 'remote', 'add', 'github', 'git@github.com:acme/demo.git');
    const info = await getRepoInfo(dir);
    expect(info?.remote).toBe('git@github.com:acme/demo.git');
  });

  it('prefers origin when several remotes exist', async () => {
    g(dir, 'remote', 'add', 'upstream', 'https://github.com/upstream/demo.git');
    g(dir, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
    const info = await getRepoInfo(dir);
    expect(info?.remote).toBe('https://github.com/acme/demo.git');
  });

  it('reports no remote for a genuinely remote-less repo', async () => {
    const info = await getRepoInfo(dir);
    expect(info).not.toBeNull();
    expect(info?.remote).toBeUndefined();
  });

  it('pins the current commit as a full SHA', async () => {
    expect(await getHeadCommit(dir)).toBe(g(dir, 'rev-parse', 'HEAD').trim());
  });

  it('returns null outside a git repository', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'xez-nogit-'));
    try {
      expect(await getRepoInfo(bare)).toBeNull();
      expect(await getHeadCommit(bare)).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

/**
 * getRepoInfo answers the repository-shape question every other subsystem
 * asks — worktree creation, diff anchoring, project registration in
 * `~/.xezar/config.json`, the GitHub tab. It never throws: a shape it cannot
 * read comes back as `null`, and degradation is the caller's policy
 * (AGENTS.md). Wrong answers do not crash; they surface layers away as a task
 * in the wrong directory or a diff anchored to the wrong ref, so each case
 * below pins the real repository shape it stands for.
 */
describe('getRepoInfo — repository shape', () => {
  it('a nested subdirectory answers with the repository ROOT, not itself', async () => {
    // xezar is booted from `packages/xezar`, or a run starts in a nested
    // package directory. Every downstream path — worktree location, diff base,
    // registry entry — is derived from `info.root`, so resolving to the
    // subdirectory would put a task in the wrong place.
    const root = initRepo();
    commit(root, 'init');
    const nested = join(root, 'packages', 'deep');
    mkdirSync(nested, { recursive: true });

    const info = await getRepoInfo(nested);
    expect(info?.root).toBe(root);
    expect(info?.branch).toBe('main');
  });

  it('a plain nested directory outside any repository stays null (no walk up into a parent)', async () => {
    // A user points xezar at a folder that is not version-controlled. The
    // answer must be "not a repository", not the nearest ancestor repository
    // that happens to exist further up the filesystem.
    const plain = scratchDir('xez-git-plain-');
    const nested = join(plain, 'a', 'b');
    mkdirSync(nested, { recursive: true });

    expect(await getRepoInfo(nested)).toBeNull();
    expect(await getHeadCommit(nested)).toBeNull();
  });

  it('a detached HEAD reports the literal "HEAD", never a fabricated branch name', async () => {
    // An agent checked out a commit rather than a branch. `branch` must not
    // become a plausible name, because callers push and diff against it.
    const root = initRepo();
    commit(root, 'one');
    const first = g(root, 'rev-parse', 'HEAD~0').trim();
    commit(root, 'two');
    g(root, 'checkout', '-q', first);

    const info = await getRepoInfo(root);
    expect(info?.root).toBe(root);
    expect(info?.branch).toBe('HEAD');
    // The commit itself is still pinned, so diff anchoring has something real.
    expect(await getHeadCommit(root)).toBe(first);
  });

  it('a repository initialised but never committed answers null (documented current behaviour)', async () => {
    // `git init` with no commit: `rev-parse --abbrev-ref HEAD` exits non-zero,
    // so getRepoInfo's outer catch degrades the whole answer to null and the
    // Repo view shows "not a git repository". This is the current contract,
    // pinned here on purpose — see the PR body, it is arguably wrong.
    const root = initRepo('xez-git-empty-');

    expect(await getRepoInfo(root)).toBeNull();
    expect(await getHeadCommit(root)).toBeNull();
  });

  it('a bare repository answers null, because it has no work tree', async () => {
    // A user points xezar at `something.git`. `rev-parse --show-toplevel`
    // fails there; the helper degrades instead of propagating the git error.
    const dir = scratchDir('xez-git-bare-');
    const bare = join(dir, 'repo.git');
    execFileSync('git', ['init', '-q', '--bare', bare], { encoding: 'utf8' });

    expect(await getRepoInfo(bare)).toBeNull();
  });

  it('a submodule working directory resolves to the SUBMODULE root, not the parent', async () => {
    // Work done inside a vendored dependency must not be attributed to the
    // parent repository — that mis-attribution is what produces five-figure
    // diffs on review runs.
    const child = initRepo('xez-git-sub-child-');
    commit(child, 'child init');
    const parent = initRepo('xez-git-sub-parent-');
    commit(parent, 'parent init');
    // `protocol.file.allow` — modern git refuses a file:// submodule source
    // without it, and the fixture source is a local path by design.
    g(parent, '-c', `protocol.file.allow=always`, ...GIT_ID, 'submodule', 'add', '-q', child, 'vendor/sub');

    const info = await getRepoInfo(join(parent, 'vendor', 'sub'));
    expect(info?.root).toBe(join(parent, 'vendor', 'sub'));
    expect(info?.root).not.toBe(parent);
  });

  it('a linked worktree resolves to the worktree root and its own branch', async () => {
    // This is xezar's own default shape: every git task runs in
    // `.local/xezar/worktrees/<runId>` on branch `xez/<id8>`. Reporting the
    // main checkout here would run the task in the user's own tree.
    const root = initRepo('xez-git-main-');
    commit(root, 'init');
    const holder = scratchDir('xez-git-linked-');
    const linked = join(holder, 'task');
    g(root, 'worktree', 'add', '-q', '-b', 'xez/abcd1234', linked);

    const info = await getRepoInfo(linked);
    expect(info?.root).toBe(linked);
    expect(info?.branch).toBe('xez/abcd1234');

    // Detach the linked worktree before teardown, so the parent repo's
    // administrative files do not race the directory removal.
    g(root, 'worktree', 'remove', '--force', linked);
  });

  it('a directory that no longer exists answers null instead of crashing the request', async () => {
    // The project registry keeps roots the user may since have deleted. The
    // route must be able to answer 409, which needs a value, not a throw.
    const gone = join(tmpdir(), 'xez-git-never-existed-0000');

    expect(await getRepoInfo(gone)).toBeNull();
    expect(await getHeadCommit(gone)).toBeNull();
  });
});

/**
 * The Repo view's read helpers. Unlike getRepoInfo these do NOT swallow git
 * failures — the routes in `server.ts` gate them behind a successful
 * getRepoInfo call and, for `getCommit`, a try/catch of their own. These tests
 * pin the shapes those routes render, plus the two guards that stop a huge
 * repository from flooding the browser.
 */
describe('repo view helpers', () => {
  it('getStatus classifies staged, unstaged and untracked paths', async () => {
    // The Repo tab's file list. A wrong code here shows the user a clean tree
    // while their work is uncommitted.
    const root = initRepo('xez-git-status-');
    writeFileSync(join(root, 'tracked.txt'), 'one\n');
    g(root, 'add', '-A');
    commit(root, 'init');

    writeFileSync(join(root, 'tracked.txt'), 'two\n');
    writeFileSync(join(root, 'added.txt'), 'new\n');
    g(root, 'add', 'added.txt');
    writeFileSync(join(root, 'untracked.txt'), 'loose\n');

    const byPath = new Map((await getStatus(root)).map((e) => [e.path, e.status]));
    expect(byPath.get('tracked.txt')).toBe('M');
    expect(byPath.get('added.txt')).toBe('A');
    expect(byPath.get('untracked.txt')).toBe('??');
  });

  it('getStatus reports an empty list for a clean tree', async () => {
    const root = initRepo('xez-git-clean-');
    commit(root, 'init');
    expect(await getStatus(root)).toEqual([]);
  });

  it('getDiff returns the working-tree patch against HEAD', async () => {
    const root = initRepo('xez-git-diff-');
    writeFileSync(join(root, 'file.txt'), 'before\n');
    g(root, 'add', '-A');
    commit(root, 'init');
    writeFileSync(join(root, 'file.txt'), 'after\n');

    const diff = await getDiff(root);
    expect(diff).toContain('-before');
    expect(diff).toContain('+after');
  });

  it('getDiff truncates past its cap, so a huge diff cannot flood the GUI', async () => {
    const root = initRepo('xez-git-diffcap-');
    writeFileSync(join(root, 'file.txt'), 'before\n');
    g(root, 'add', '-A');
    commit(root, 'init');
    writeFileSync(join(root, 'file.txt'), `${'x'.repeat(5_000)}\n`);

    const diff = await getDiff(root, 200);
    expect(diff.endsWith('\n… (diff truncated)')).toBe(true);
    expect(diff.length).toBe(200 + '\n… (diff truncated)'.length);
  });

  it('getBranches hides xezar task branches from the base-branch picker', async () => {
    // Every xezar run creates `xez/<id8>`. Offering those as a base branch
    // would let a user anchor new work on a finished task's throwaway branch.
    const root = initRepo('xez-git-branches-');
    commit(root, 'init');
    g(root, 'branch', 'feature/one');
    g(root, 'branch', 'xez/abcd1234');

    const branches = await getBranches(root);
    expect(branches).toContain('main');
    expect(branches).toContain('feature/one');
    expect(branches).not.toContain('xez/abcd1234');
    // Sorted, so the picker's order does not depend on git's ref order.
    expect(branches).toEqual([...branches].sort((a, b) => a.localeCompare(b)));
  });

  it('getBranches folds origin/<name> into <name>, and today leaks a bare "origin" entry', async () => {
    // A repo with a fetched remote lists the same branch twice — once local,
    // once remote-tracking — and the picker must offer it once.
    const upstream = initRepo('xez-git-upstream-');
    commit(upstream, 'init');
    g(upstream, 'branch', 'release');

    const root = initRepo('xez-git-clone-');
    commit(root, 'init');
    g(root, 'remote', 'add', 'origin', upstream);
    g(root, 'fetch', '-q', 'origin');
    g(root, 'remote', 'set-head', 'origin', '-a');

    const branches = await getBranches(root);
    // Remote-only branches reach the picker under their plain name.
    expect(branches).toContain('release');
    // The local `main` and `origin/main` collapse into one entry.
    expect(branches.filter((b) => b === 'main')).toHaveLength(1);
    expect(branches.some((b) => b.startsWith('origin/'))).toBe(false);
    // KNOWN DEFECT, pinned here rather than fixed (out of scope for this
    // issue): `refs/remotes/origin/HEAD` shortens to the bare string `origin`
    // under `--format=%(refname:short)` (git 2.55), so the module's
    // `name.includes('HEAD')` skip never fires and the base-branch picker is
    // offered an entry called `origin`, which is not a branch. See the PR body.
    expect(branches).toContain('origin');
  });

  it('getCommit refuses anything that is not a commit hash', async () => {
    // `/api/v1/.../repo/commit/:sha` puts a URL segment straight into a git
    // argument list. The guard is what stops `--upload-pack=…`-style values
    // and stray refspecs from reaching git at all.
    const root = initRepo('xez-git-commit-');
    commit(root, 'init');

    expect(await getCommit(root, 'HEAD')).toBe('(not a commit hash)');
    expect(await getCommit(root, '../../etc/passwd')).toBe('(not a commit hash)');
    expect(await getCommit(root, '--upload-pack=touch')).toBe('(not a commit hash)');
    expect(await getCommit(root, 'abc')).toBe('(not a commit hash)'); // too short
  });

  it('getCommit renders one commit as message + stat + patch', async () => {
    const root = initRepo('xez-git-show-');
    writeFileSync(join(root, 'file.txt'), 'one\n');
    g(root, 'add', '-A');
    g(root, ...GIT_ID, 'commit', '-q', '-m', 'the subject line');
    const sha = g(root, 'rev-parse', 'HEAD').trim();

    const out = await getCommit(root, sha);
    expect(out).toContain('the subject line');
    expect(out).toContain('file.txt');
    expect(out).toContain('+one');
  });

  it('getCommit truncates past its cap', async () => {
    const root = initRepo('xez-git-showcap-');
    writeFileSync(join(root, 'file.txt'), `${'y'.repeat(5_000)}\n`);
    g(root, 'add', '-A');
    g(root, ...GIT_ID, 'commit', '-q', '-m', 'big');
    const sha = g(root, 'rev-parse', 'HEAD').trim();

    const out = await getCommit(root, sha, 100);
    expect(out.endsWith('\n… (diff truncated)')).toBe(true);
    expect(out.length).toBe(100 + '\n… (diff truncated)'.length);
  });

  it('getLog returns newest-first entries with hash, subject and author', async () => {
    const root = initRepo('xez-git-log-');
    commit(root, 'first');
    commit(root, 'second');

    const log = await getLog(root);
    expect(log.map((e) => e.subject)).toEqual(['second', 'first']);
    expect(log[0]?.author).toBe('t');
    expect(log[0]?.hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(log[0]?.when).not.toBe('');
  });

  it('getLog honours the requested count', async () => {
    const root = initRepo('xez-git-logcount-');
    commit(root, 'one');
    commit(root, 'two');
    commit(root, 'three');

    expect(await getLog(root, 2)).toHaveLength(2);
  });
});
