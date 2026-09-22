import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import extension, { __internals } from '../../scripts/pi-worktree-guard.ts';
import { agentDirectories } from '../workflows/run.ts';

const roots: string[] = [];
const originalHome = process.env.HOME;

function tempDir(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

interface Fixture {
  home: string;
  primary: string;
  worktree: string;
  runs: string;
  outside: string;
}

/** The normal layout: the primary checkout sits under a fixture HOME, so `~/…` is exercised for
 *  real, and the task worktree sits under the primary checkout's `.local/xezar/worktrees`. */
function fixture(primaryName = 'repo'): Fixture {
  const home = tempDir('xez-pi-guard-home-');
  process.env.HOME = home;
  const primary = join(home, 'Projects', primaryName);
  const worktree = join(primary, '.local', 'xezar', 'worktrees', 'task');
  const runs = join(primary, '.local', 'xezar', 'runs');
  mkdirSync(join(primary, '.git', 'worktrees', 'task'), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(primary, '.git', 'worktrees', 'task')}\n`);
  return { home, primary, worktree, runs, outside: tempDir('xez-pi-guard-outside-') };
}

type ToolCall = Parameters<typeof __internals.guardToolCall>[2];

function guard(f: Fixture, event: ToolCall, allowed: string[] = []) {
  return __internals.guardToolCall(f.worktree, f.worktree, event, f.primary, allowed);
}

const write = (path: string): ToolCall => ({ toolName: 'write', input: { path, content: 'x' } });
const bash = (command: string): ToolCall => ({ toolName: 'bash', input: { command } });
const BLOCK = { block: true };

const caseInsensitiveFs = (() => {
  const dir = tempDir('xez-pi-guard-case-');
  mkdirSync(join(dir, 'lower'));
  return existsSync(join(dir, 'LOWER'));
})();

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pi linked-worktree tool guard (#537)', () => {
  it('allows relative writes inside the worktree', () => {
    expect(guard(fixture(), write('notes.md'))).toBeUndefined();
  });

  it('blocks absolute writes into the primary checkout', () => {
    const f = fixture();
    expect(guard(f, { toolName: 'edit', input: { path: join(f.primary, 'tracked.md') } })).toMatchObject(BLOCK);
  });

  it('blocks a relative .. escape', () => {
    const f = fixture();
    expect(guard(f, write(relative(f.worktree, join(dirname(f.worktree), 'peer', 'tracked.md'))))).toMatchObject(BLOCK);
  });

  it('blocks a write through a symlink that escapes the worktree', () => {
    const f = fixture();
    symlinkSync(f.outside, join(f.worktree, 'escape'));
    expect(guard(f, write('escape/tracked.md'))).toMatchObject(BLOCK);
  });

  it('allows the existing absolute temp and home locations outside the primary checkout', () => {
    const f = fixture();
    for (const path of [join(f.outside, 'xez-allowed.txt'), join(homedir(), '.cache', 'xez-allowed.txt'), '~/.cache/xez-allowed.txt']) {
      expect(guard(f, write(path))).toBeUndefined();
    }
  });

  it('fails closed when the configured worktree root cannot be resolved', () => {
    const f = fixture();
    const missing = join(f.worktree, 'missing-root');
    expect(__internals.guardToolCall(missing, f.worktree, write('notes.md'), f.primary, [])).toMatchObject(BLOCK);
  });

  describe('Major 1: file-tool paths are normalised the way pi 0.85.1 resolves them', () => {
    it.each([
      ['a ~/ path', (f: Fixture) => `~/${relative(f.home, join(f.primary, 'tracked.md'))}`],
      ['a leading @', (f: Fixture) => `@${join(f.primary, 'tracked.md')}`],
      ['a file:// URL', (f: Fixture) => pathToFileURL(join(f.primary, 'tracked.md')).href],
      ['@ plus ~/', (f: Fixture) => `@~/${relative(f.home, join(f.primary, 'tracked.md'))}`],
    ])('blocks %s that pi expands into the primary checkout', (_name, spell) => {
      const f = fixture();
      expect(guard(f, write(spell(f)))).toMatchObject(BLOCK);
      expect(guard(f, { toolName: 'edit', input: { path: spell(f), edits: [] } })).toMatchObject(BLOCK);
    });

    it('blocks a Unicode-space spelling that pi turns into the primary checkout path', () => {
      const f = fixture('my repo');
      expect(guard(f, write('~/Projects/my repo/tracked.md'))).toMatchObject(BLOCK);
    });

    it.runIf(caseInsensitiveFs)('blocks a differently cased spelling on a case-insensitive file system', () => {
      const f = fixture();
      expect(guard(f, write(join(f.primary, 'tracked.md').toUpperCase()))).toMatchObject(BLOCK);
    });

    it.each([
      ['~user/x', '~someone/tracked.md'],
      ['a double @', '@@notes.md'],
      ['file: without //', 'file:notes.md'],
      ['a file URL with a remote host', 'file://remote-host/tracked.md'],
    ])('fails closed on a spelling it cannot normalise with confidence: %s', (_name, path) => {
      expect(guard(fixture(), write(path))).toMatchObject(BLOCK);
    });

    it('still allows the normalised spellings that land inside the worktree', () => {
      const f = fixture();
      for (const path of ['@notes.md', pathToFileURL(join(f.worktree, 'notes.md')).href, `~/${relative(f.home, join(f.worktree, 'notes.md'))}`]) {
        expect(guard(f, write(path))).toBeUndefined();
      }
    });
  });

  describe('Major 2: best-effort shell check covers the ordinary cd / git -C variants', () => {
    it.each([
      ['git -C primary', (p: string) => `git -C ${JSON.stringify(p)} status`],
      ['cd primary', (p: string) => `cd ${JSON.stringify(p)} && git status`],
      ['a leading space', (p: string) => ` cd ${p} && git commit -am x`],
      ['cd -P', (p: string) => `cd -P ${p} && git commit -am x`],
      ['cd inside if/then', (p: string) => `if true; then cd ${p}; git commit -am x; fi`],
      ['git -c k=v before -C', (p: string) => `git -c user.name=x -C ${p} commit -am x`],
      ['--git-dir= / --work-tree=', (p: string) => `git --git-dir=${p}/.git --work-tree=${p} commit -am x`],
      ['--git-dir as a separate word', (p: string) => `git --git-dir ${p}/.git status`],
      ['GIT_DIR / GIT_WORK_TREE env assignment', (p: string) => `GIT_DIR=${p}/.git GIT_WORK_TREE=${p} git commit -am x`],
      ['pushd', (p: string) => `pushd ${p} && git status`],
      ['a subshell', (p: string) => `(cd ${p} && git commit -am x)`],
      ['sh -c with a quoted script', (p: string) => `sh -c "cd ${p} && git commit -am x"`],
      ['single quotes', (p: string) => `cd '${p}' && git status`],
      ['a redirect into the primary', (p: string) => `echo x >> ${p}/tracked.md`],
      ['a chained command after a harmless one', (p: string) => `npm test; git -C ${p} commit -am x`],
    ])('blocks %s', (_name, command) => {
      const f = fixture();
      expect(guard(f, bash(command(f.primary)))).toMatchObject(BLOCK);
    });

    it.each([
      ['cd ~/…', (f: Fixture) => `cd ~/${relative(f.home, f.primary)} && git status`],
      ['cd $HOME/…', (f: Fixture) => `cd $HOME/${relative(f.home, f.primary)} && git status`],
      ['cd "${HOME}/…"', (f: Fixture) => `cd "\${HOME}/${relative(f.home, f.primary)}" && git status`],
      ['cd ~ then a relative cd', (f: Fixture) => `cd ~ && cd ${relative(f.home, f.primary)} && git commit -am x`],
      ['a relative cd out of the worktree', (f: Fixture) => `cd ${relative(f.worktree, f.primary)} && git status`],
      ['a relative git -C out of the worktree', (f: Fixture) => `git -C ${relative(f.worktree, f.primary)} commit -am x`],
      ['a relative redirect out of the worktree', (f: Fixture) => `echo x > ${relative(f.worktree, join(f.primary, 'tracked.md'))}`],
      ['a symlink to the primary', (f: Fixture) => {
        symlinkSync(f.primary, join(f.outside, 'link'));
        return `cd ${join(f.outside, 'link')} && git status`;
      }],
      ['an unknown variable as the cd target', () => 'cd "$XEZ_GUARD_UNSET_VARIABLE" && git status'],
      ['command substitution as the cd target', () => 'cd $(git rev-parse --show-toplevel)/../.. && git status'],
    ])('blocks %s', (_name, command) => {
      const f = fixture();
      expect(guard(f, bash(command(f)))).toMatchObject(BLOCK);
    });

    it.each([
      ['plain project commands', () => 'npm test && git status && git commit -am x'],
      ['cd into a subfolder and back', () => 'cd packages/web && npm test && cd .. && cd ..'],
      ['bare cd (HOME)', () => 'cd && ls'],
      ['cd ~', () => 'cd ~ && ls .cache'],
      ['a temp folder outside the primary', (f: Fixture) => `cd ${f.outside} && echo hi > ${f.outside}/out.txt`],
      ['git -C the worktree itself', (f: Fixture) => `git -C ${f.worktree} status`],
      ['git ranges and grep -C', () => 'git log origin/main..HEAD && grep -C 3 foo README.md'],
      ['cd through a worktree symlink that points outside the primary', (f: Fixture) => {
        symlinkSync(f.outside, join(f.worktree, 'linked-cache'));
        return 'cd linked-cache && ls';
      }],
    ])('allows %s', (_name, command) => {
      const f = fixture();
      expect(guard(f, bash(command(f)))).toBeUndefined();
    });
  });

  describe('Major 2, round 2: a directory change the guard cannot resolve to one literal path is refused', () => {
    const withEnv = (name: string, value: string, run: () => void) => {
      const saved = process.env[name];
      process.env[name] = value;
      try {
        run();
      } finally {
        if (saved === undefined) delete process.env[name];
        else process.env[name] = saved;
      }
    };
    /** `pk` is an in-worktree symlink to the primary checkout's `packages` folder. */
    const linkPackages = (f: Fixture) => {
      mkdirSync(join(f.primary, 'packages'), { recursive: true });
      symlinkSync(join(f.primary, 'packages'), join(f.worktree, 'pk'));
    };

    it.each([
      ['row 1: a ? glob in the cd target', (f: Fixture) => `cd ${f.home}/Projects/xeza? && git commit -qam glob1`],
      ['row 2: a * glob in the git -C target', (f: Fixture) => `git -C ${f.home}/Projects/xez* commit -q --allow-empty -m glob2`],
      ['row 3: a [..] glob after ~/', () => 'cd ~/Projects/xeza[r] && git commit -qam glob3'],
      ['row 4: a brace expansion in the cd target', (f: Fixture) => `cd ${f.home}/Projects/{xezar,} && git commit -qam brace`],
      ['row 5: cd ~user', () => 'cd ~someuser/Projects/xezar && git commit -am x'],
      ['row 5: git -C ~user', () => 'git -C ~someuser/Projects/xezar commit -am x'],
      ['row 6: a CDPATH assignment before cd', (f: Fixture) => `CDPATH=${f.home}/Projects cd xezar && git commit -qam cdpath`],
      ['row 6: an exported CDPATH', (f: Fixture) => `export CDPATH=${f.home}/Projects; cd xezar && git commit -qam cdpath`],
      ['row 7: cd -P through an in-worktree symlink and ..', (f: Fixture) => {
        linkPackages(f);
        return 'cd -P pk/.. && git commit -qam symP';
      }],
      ['row 7: git -C through an in-worktree symlink and ..', (f: Fixture) => {
        linkPackages(f);
        return 'git -C pk/.. commit -q --allow-empty -m symC';
      }],
      ['minor: a backtick substitution as the cd target', () => 'cd `echo x` && git status'],
    ])('blocks %s', (_name, command) => {
      const f = fixture('xezar');
      expect(guard(f, bash(command(f)))).toMatchObject(BLOCK);
    });

    it.each([
      ['a variable, even one that is known and outside the primary', (f: Fixture) => {
        process.env.XEZ_GUARD_OUTSIDE = f.outside;
        return 'cd "$XEZ_GUARD_OUTSIDE" && ls';
      }],
      ['env -C with a glob', (f: Fixture) => `env -C ${f.home}/Projects/xez* git commit -am x`],
      ['env --chdir= with a glob', (f: Fixture) => `env --chdir=${f.home}/Projects/xez* git commit -am x`],
      ['pushd with a glob', (f: Fixture) => `pushd ${f.home}/Projects/xeza? && git commit -am x`],
      ['--work-tree= with a glob', (f: Fixture) => `git --git-dir=${f.home}/Projects/xez*/.git --work-tree=${f.home}/Projects/xez* commit -am x`],
      ['~+ as the cd target', () => 'cd ~+ && git status'],
      ['cd ~/… after HOME is reassigned in the command', (f: Fixture) => `HOME=${f.home}/Projects; cd ~/xezar && git commit -am x`],
      ['a relative .. after an allowed symlink cd', (f: Fixture) => {
        symlinkSync(f.outside, join(f.worktree, 'linked-cache'));
        return 'cd linked-cache && cd ../x && ls';
      }],
      ['a glob redirect whose literal directory holds the primary', () => 'echo x >> ~/Projects/xeza?/tracked.md'],
      ['a relative redirect through a symlink and ..', (f: Fixture) => {
        linkPackages(f);
        return 'echo x >> pk/../tracked.md';
      }],
      ['cd - before any directory change', () => 'cd - && git commit -am x'],
    ])('blocks %s', (_name, command) => {
      const f = fixture('xezar');
      try {
        expect(guard(f, bash(command(f)))).toMatchObject(BLOCK);
      } finally {
        delete process.env.XEZ_GUARD_OUTSIDE;
      }
    });

    it('blocks a cd that an inherited CDPATH sends into the primary checkout', () => {
      const f = fixture('xezar');
      withEnv('CDPATH', join(f.home, 'Projects'), () => {
        expect(guard(f, bash('cd xezar && git commit -am x'))).toMatchObject(BLOCK);
      });
    });

    it.each([
      ['the reviewer control ls && npm test', () => 'ls && npm test'],
      ['the reviewer control cd packages/web and back', () => 'cd packages/web && npm test && cd .. && cd ..'],
      ['the reviewer control git ranges and grep -C', () => 'git log a..b && grep -C 3 foo README.md'],
      ['the reviewer control cd /tmp', () => 'cd /tmp'],
      ['quoted patterns that only look like globs', () => "awk '{print $1}' x.txt && grep -E 'a.*b' x.txt && find . -name '*.ts'"],
      ['a glob under a folder outside the primary', (f: Fixture) => `ls ${f.outside}/*.txt && cd ${f.outside} && ls *`],
      ['a relative glob in the worktree', () => 'ls packages/*/src && git add -- *.md'],
      ['cd back with cd -', () => 'cd packages && cd - && git status'],
    ])('still allows %s', (_name, command) => {
      const f = fixture('xezar');
      expect(guard(f, bash(command(f)))).toBeUndefined();
    });

    it('still allows a relative cd when an inherited CDPATH names no other matching folder', () => {
      const f = fixture('xezar');
      mkdirSync(join(f.worktree, 'packages'));
      withEnv('CDPATH', f.outside, () => {
        expect(guard(f, bash('cd packages && npm test'))).toBeUndefined();
      });
    });
  });

  describe('N3, round 3: a relative mention is followed from the directory the command reached', () => {
    it.each([
      ['N3: cd to an ancestor, then a relative redirect', (f: Fixture) => `cd ${f.home}/Projects && echo n3 >> xezar/tracked.md`],
      ['N3: cd ~/… to an ancestor, then sed -i', () => 'cd ~/Projects && sed -i "" s/a/b/ xezar/tracked.md'],
      ['N3: pushd to an ancestor, then cp', (f: Fixture) => `pushd ${f.home}/Projects && cp notes.md xezar/notes.md`],
      ['N3: a relative glob from an ancestor', () => 'cd ~/Projects && cat */tracked.md'],
      ['N5: a relative redirect through an existing worktree symlink', (f: Fixture) => {
        mkdirSync(join(f.primary, 'packages'), { recursive: true });
        symlinkSync(join(f.primary, 'packages'), join(f.worktree, 'pk'));
        return 'echo n5 >> pk/tracked.md';
      }],
      ['a relative mention after the guard lost the directory', () => 'pushd packages && pushd +1 && echo x >> tracked.md'],
    ])('blocks %s', (_name, command) => {
      const f = fixture('xezar');
      expect(guard(f, bash(command(f)))).toMatchObject(BLOCK);
    });

    it.each([
      ['the control cd /tmp && sed', () => 'cd /tmp && sed s/a/b/ x'],
      ['ls -la && git status --short', () => 'ls -la && git status --short'],
      ['git log && git diff --stat', () => 'git log --oneline -3 && git diff --stat HEAD~0'],
      ['mkdir, cd in, write, cd back, cat', () => 'mkdir -p src && cd src && echo hi > a.txt && cd .. && cat src/a.txt'],
      ['grep and rg with a glob', () => "grep -rn \"hi\" src | head -5; rg -g '*.txt' hi . || true"],
      ['a here-doc then git add and commit', () => "cat > notes.md <<'EOF'\nsome notes\nEOF\ngit add notes.md && git commit -qm notes"],
      ['cd /tmp and back with cd -', () => 'cd /tmp && ls >/dev/null && cd -'],
    ])('still allows %s', (_name, command) => {
      const f = fixture('xezar');
      expect(guard(f, bash(command()))).toBeUndefined();
    });
  });

  describe('Major 2, round 4: a quoted word is one argument, not a command line (#652)', () => {
    it.each([
      ['RED: a bare quoted .. (a printf argument, a pasted listing token)', () => "printf '%s\\n' '..'"],
      ['RED: an inline-quoted cd fragment in a commit message', () => 'git commit -m "cd .."'],
      ['RED: a quoted .. among other arguments', () => "printf '%s\\n' a '..' b"],
      ['RED: a quoted listing line', () => 'git log --format=".."'],
      ['GUARD: the required control echo "cd /elsewhere"', () => 'echo "cd /elsewhere"'],
      ['GUARD: a quoted pattern that merely looks like a glob', () => "grep -rn 'cd /elsewhere' packages"],
      ['GUARD: a quoted script for a program that is not a shell', () => "awk '{print $1}' x.txt"],
    ])('allows %s', (_name, command) => {
      expect(guard(fixture(), bash(command()))).toBeUndefined();
    });

    it.each([
      ['GUARD: a real cd .. out of the worktree', () => 'cd ..'],
      ['GUARD: a command-substituted cd out of the worktree', () => 'cd "$(git rev-parse --show-toplevel)/.."'],
      ['GUARD: a ;-chained real cd into the primary', (f: Fixture) => `echo hi; cd ${f.primary} && git status`],
      ['GUARD: an &&-chained real cd into the primary', (f: Fixture) => `true && cd ${f.primary} && git status`],
      ['GUARD: a |-chained real cd into the primary', (f: Fixture) => `echo hi | cd ${f.primary}`],
      ['GUARD: an unquoted .. argument (a deletion target)', () => 'rm -rf ..'],
      ['GUARD: a quoted .. as a directory-change operand', () => "cd '..'"],
      ['GUARD: a quoted .. as a git -C operand', () => "git -C '..' status"],
      ['GUARD: a quoted shell script', (f: Fixture) => `sh -c "cd ${f.primary} && git status"`],
      ['GUARD: a quoted shell script through a combined flag', (f: Fixture) => `bash -lc "cd ${f.primary} && git status"`],
      ['GUARD: a quoted single-quoted shell script', (f: Fixture) => `sh -c 'cd ${f.primary} && git status'`],
      ['GUARD: a quoted fish script', (f: Fixture) => `fish -c "cd ${f.primary} && git status"`],
      ['GUARD: an eval argument', (f: Fixture) => `eval "cd ${f.primary}"`],
      ['GUARD: a quoted redirect target', (f: Fixture) => `echo x > "${f.primary}/tracked.md"`],
    ])('still refuses %s', (_name, command) => {
      const f = fixture();
      expect(guard(f, bash(command(f)))).toMatchObject(BLOCK);
    });

    it('GUARD: a script nested deeper than the guard will follow is refused, never thrown', () => {
      const f = fixture();
      let command = `echo x > ${f.primary}/tracked.md`;
      for (let i = 0; i < 12; i++) command = `sh -c ${JSON.stringify(command)}`;
      expect(guard(f, bash(command))).toMatchObject(BLOCK);
    });

    it('GUARD: the chained cd refusal does not depend on the quote of the cd itself', () => {
      const f = fixture();
      for (const command of [`cd ${f.primary}`, `cd '${f.primary}'`, `cd "${f.primary}"`]) {
        expect(guard(f, bash(command))).toMatchObject(BLOCK);
      }
    });
  });

  describe('Round 1 review: a shell flag\u2019s separate argument, and the quoted-.. exemption (#652)', () => {
    it.each([
      ['RED: -o takes a separate argument before -c', (f: Fixture) => `bash -o pipefail -c 'cd ${f.primary} && rm -rf x'`],
      ['RED: -euo takes a separate argument before -c', (f: Fixture) => `bash -euo pipefail -c 'cd ${f.primary}'`],
      ['RED: a long option takes a separate argument before -c', (f: Fixture) => `bash --rcfile /dev/null -c 'cd ${f.primary}'`],
      ['RED: sh -o errexit -c', (f: Fixture) => `sh -o errexit -c 'cd ${f.primary}'`],
      ['RED: zsh -o pipefail -c', (f: Fixture) => `zsh -o pipefail -c 'cd ${f.primary}'`],
      ['RED: a -c whose script is not quoted at all fails closed', () => 'bash -c ls'],
      ['RED: an interpreter word with no operand at all fails closed', () => 'sh -c'],
      ['GUARD: a quoted script behind only dash-prefixed flags', (f: Fixture) => `bash --noprofile --norc -c 'cd ${f.primary}'`],
      ['GUARD: a quoted script behind a combined flag', (f: Fixture) => `bash -lc 'cd ${f.primary}'`],
      ['GUARD: a quoted script behind a bare -c', (f: Fixture) => `bash -c 'cd ${f.primary}'`],
      ['GUARD: a quoted script through a path-spelled interpreter', (f: Fixture) => `env sh -c 'cd ${f.primary}'`],
    ])('still refuses %s', (_name, command) => {
      const f = fixture();
      expect(guard(f, bash(command(f)))).toMatchObject(BLOCK);
    });

    it.each([
      ['RED: a quoted .. handed to rm', () => "rm -rf '..'"],
      ['RED: a double-quoted .. handed to rm', () => 'rm -rf ".."'],
      ['RED: a quoted .. as mv\u2019s destination', () => "mv notes.md '..'"],
      ['RED: a quoted ../.. as cp\u2019s destination', () => "cp -r . '../..'"],
      ['RED: a quoted ../ as rsync\u2019s destination', () => "rsync -a . '../'"],
      ['RED: a quoted .. as find\u2019s search root', () => "find '..' -delete"],
      ['RED: a quoted .. as chmod\u2019s target', () => "chmod -R 777 '..'"],
      ['RED: a quoted .. with a trailing slash', () => "rm -rf '../'"],
      ['GUARD: an unquoted .. deletion target', () => 'rm -rf ..'],
      ['GUARD: a quoted .. as a directory-change operand', () => "cd '..'"],
      ['GUARD: a quoted .. as a git -C operand', () => "git -C '..'"],
      ['GUARD: a quoted .. as a tar -C operand', () => "tar -C '..'"],
      ['GUARD: a quoted .. as a redirect target', () => "echo hi > '../out.txt'"],
    ])('still refuses %s', (_name, command) => {
      expect(guard(fixture(), bash(command()))).toMatchObject(BLOCK);
    });

    it.each([
      ['GUARD: printf prints a quoted .. (AC-2)', () => "printf '%s\\n' '..'"],
      ['GUARD: echo prints a quoted .. (AC-2)', () => "echo '..'"],
      ['GUARD: a quoted .. among a printf\u2019s other arguments', () => "printf '%s\\n' a '..' b"],
      ['GUARD: a quoted .. as an option VALUE is a string, not an operand', () => 'git log --format=".."'],
    ])('allows %s', (_name, command) => {
      expect(guard(fixture(), bash(command()))).toBeUndefined();
    });
  });

  /** Round 1 stopped reading a flag's UNQUOTED argument as the script. The scoped re-check found
   *  the other half: a flag whose argument is QUOTED (`bash --rcfile 'x' -c '<script>'`) was read
   *  as the script instead, and the real `-c` operand — which a live shell runs regardless of
   *  `--rcfile` — was never read. One row per flag that takes a SEPARATE word in bash, sh, dash,
   *  ksh or zsh, so the class is closed rather than the two reported spellings. */
  describe('Scoped re-check: the script is anchored at the command flag, not at the first quoted word (#652)', () => {
    it.each([
      // The two spellings the scoped re-checker measured and proved red at dbb4b559.
      ['RED (re-check): a quoted --rcfile argument precedes the real -c', (f: Fixture) => `bash --rcfile 'x' -c 'cd ${f.primary} && rm -rf x'`],
      ['RED (re-check): a quoted --init-file argument precedes the real -c', (f: Fixture) => `bash --init-file 'x' -c 'cd ${f.primary}'`],
      // One row per argument-taking flag, per shell.
      ['RED: bash -o takes a separate QUOTED argument', (f: Fixture) => `bash -o 'pipefail' -c 'cd ${f.primary}'`],
      ['RED: bash +o takes a separate QUOTED argument', (f: Fixture) => `bash +o 'noclobber' -c 'cd ${f.primary}'`],
      ['RED: bash -O (shopt) takes a separate QUOTED argument', (f: Fixture) => `bash -O 'extglob' -c 'cd ${f.primary}'`],
      ['RED: bash +O (shopt) takes a separate QUOTED argument', (f: Fixture) => `bash +O 'extglob' -c 'cd ${f.primary}'`],
      ['RED: sh -o takes a separate QUOTED argument', (f: Fixture) => `sh -o 'nounset' -c 'cd ${f.primary}'`],
      ['RED: dash -o takes a separate QUOTED argument', (f: Fixture) => `dash -o 'errexit' -c 'cd ${f.primary}'`],
      ['RED: ksh -o takes a separate QUOTED argument', (f: Fixture) => `ksh -o 'pipefail' -c 'cd ${f.primary}'`],
      ['RED: zsh -o takes a separate QUOTED argument', (f: Fixture) => `zsh -o 'pipefail' -c 'cd ${f.primary}'`],
      ['RED: zsh +o takes a separate QUOTED argument', (f: Fixture) => `zsh +o 'nomatch' -c 'cd ${f.primary}'`],
      ['RED: a combined short cluster ending in -o takes one', (f: Fixture) => `bash -euo 'pipefail' -c 'cd ${f.primary}'`],
      ['RED: two argument-taking long options in a row', (f: Fixture) => `bash --rcfile 'x' --init-file 'y' -c 'cd ${f.primary}'`],
      ['RED: the -c flag itself is quoted', (f: Fixture) => `bash '-c' 'cd ${f.primary}'`],
      ['RED: -co asks for a command string AND consumes a word', (f: Fixture) => `bash -co 'pipefail' 'cd ${f.primary}'`],
      ['RED: an argument-taking flag AFTER the -c', (f: Fixture) => `bash -c --rcfile 'x' 'cd ${f.primary}'`],
      ['RED: a flag argument before a -c whose script is unquoted fails closed', () => "bash --rcfile 'x' -c ls"],
      // Already refused before this round; they pin what the anchor must NOT lose.
      ['GUARD: zsh --emulate takes a separate QUOTED argument', (f: Fixture) => `zsh --emulate 'sh' -c 'cd ${f.primary}'`],
      ['GUARD: -- ends option parsing, and the segment is refused anyway', (f: Fixture) => `bash -- -c 'cd ${f.primary}'`],
      ['GUARD: -ec, a cluster whose c is not last', (f: Fixture) => `bash -ec 'cd ${f.primary}'`],
      ['GUARD: -xc, another such cluster', (f: Fixture) => `bash -xc 'cd ${f.primary}'`],
      ['GUARD: an =-attached argument consumes no word', (f: Fixture) => `bash --rcfile=x -c 'cd ${f.primary}'`],
      ['GUARD: the script is behind the flag, not before it', (f: Fixture) => `bash -c 'cd ${f.primary}' --rcfile 'x'`],
      ['GUARD: eval keeps its no-flag anchor', (f: Fixture) => `eval 'cd ${f.primary}'`],
    ])('still refuses %s', (_name, command) => {
      const f = fixture();
      expect(guard(f, bash(command(f)))).toMatchObject(BLOCK);
    });

    it.each([
      ['GUARD: a benign script behind --rcfile', () => "bash --rcfile 'x' -c 'ls'"],
      ['GUARD: a benign script behind -o', () => "bash -o 'pipefail' -c 'echo hi'"],
      ['GUARD: a benign script behind -euo', () => "bash -euo 'pipefail' -c 'npm test'"],
      ['GUARD: a benign script behind -co', () => "bash -co 'pipefail' 'npm test'"],
      ['GUARD: a quoted script for a program that is not a shell', () => "awk '{print $1}' x.txt"],
    ])('allows %s', (_name, command) => {
      expect(guard(fixture(), bash(command()))).toBeUndefined();
    });
  });

  describe('Major 3: the primary checkout comes from Xezar, not from the .git marker', () => {
    it.each([
      ['a worktree of a bare repository', 'proj.git'],
      ['a submodule', join('super', '.git', 'modules', 'proj')],
    ])('keeps ordinary tool calls working for %s', (_name, gitDirParent) => {
      const base = tempDir('xez-pi-guard-layout-');
      const primary = join(base, 'proj');
      const worktree = join(primary, '.local', 'xezar', 'worktrees', 't');
      mkdirSync(join(base, gitDirParent, 'worktrees', 't'), { recursive: true });
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(worktree, '.git'), `gitdir: ${join(base, gitDirParent, 'worktrees', 't')}\n`);
      const call = (event: ToolCall) => __internals.guardToolCall(worktree, worktree, event, primary, []);
      expect(call(bash('ls'))).toBeUndefined();
      expect(call(bash('npm test'))).toBeUndefined();
      expect(call(write('notes.md'))).toBeUndefined();
      expect(call(write(join(primary, 'tracked.md')))).toMatchObject(BLOCK);
    });
  });

  describe('the run’s granted folders under the primary checkout (handoff file, task temp)', () => {
    it('allows writing the handoff file and task temp when Xezar granted them', () => {
      const f = fixture();
      const tmp = join(f.primary, '.local', 'xezar', 'tmp', 'task');
      mkdirSync(tmp, { recursive: true });
      expect(guard(f, write(join(f.runs, 'task.handoff.md')), [f.runs, tmp])).toBeUndefined();
      expect(guard(f, bash(`echo done >> ${join(f.runs, 'task.handoff.md')} && cd ${tmp} && ls`), [f.runs, tmp])).toBeUndefined();
      expect(guard(f, write(join(f.runs, 'task.handoff.md')))).toMatchObject(BLOCK);
    });
  });

  describe('the run’s own task evidence directory (#652)', () => {
    const RUN = '3d0348dc-815b-4e47-ad89-ef537ca4a2f0';
    const OTHER_RUN = '00000000-1111-4222-8333-444444444444';
    /** The convention under test, spelled ONCE here: the evidence root the kit
     *  writes today and the frozen historical root of the #665 dual-read window. */
    const evidenceOf = (f: Fixture, runId: string) => join(f.primary, '.local', 'xezar', 'tasks', runId);
    const frozenOf = (f: Fixture, runId: string) => join(f.primary, '.local', 'xezar-tasks', runId);
    /** The roots the fix must produce for ONE run, built HERE so the GUARD cases below run on
     *  BOTH sides of the fix — they are controls, not the regression. The RED case additionally
     *  pins the production producer to exactly this list: `agentDirectories` is what fills
     *  `additionalDirectories`, which the pi runner passes as `--xezar-allowed-roots`. */
    const rootsFor = (f: Fixture, runId: string) => [f.runs, evidenceOf(f, runId), frozenOf(f, runId)];
    const produced = (f: Fixture, env: Record<string, string>) =>
      agentDirectories(f.primary, join(f.primary, '.local', 'xezar'), env);

    it('RED: the producer grants this run its evidence directory and the guard allows the kit’s write', () => {
      const f = fixture();
      // The frozen root is granted only while it already exists (#690), so
      // create it: with both there, the producer is pinned to both roots.
      mkdirSync(frozenOf(f, RUN), { recursive: true });
      const allowed = produced(f, { XEZ_TASK_ID: RUN });
      expect(allowed).toEqual(rootsFor(f, RUN));
      // Fail closed on a run that cannot name itself — part of the same producer.
      expect(produced(f, {})).toEqual([f.runs]);
      expect(produced(f, { XEZ_TASK_ID: '..' })).toEqual([f.runs]);
      const redProofs = join(evidenceOf(f, RUN), 'red-proofs');
      expect(guard(f, bash(`mkdir -p ${redProofs} && echo x > ${redProofs}/x.txt`), allowed)).toBeUndefined();
      expect(guard(f, write(join(redProofs, 'x.txt')), allowed)).toBeUndefined();
      expect(guard(f, write(join(frozenOf(f, RUN), 'notes.md')), allowed)).toBeUndefined();
    });

    it('GUARD: the same path for ANOTHER run id stays refused, under either evidence root', () => {
      const f = fixture();
      const allowed = rootsFor(f, RUN);
      expect(guard(f, bash(`echo x > ${join(evidenceOf(f, OTHER_RUN), 'red-proofs', 'x.txt')}`), allowed)).toMatchObject(BLOCK);
      expect(guard(f, write(join(evidenceOf(f, OTHER_RUN), 'red-proofs', 'x.txt')), allowed)).toMatchObject(BLOCK);
      expect(guard(f, write(join(frozenOf(f, OTHER_RUN), 'x.txt')), allowed)).toMatchObject(BLOCK);
    });

    it('GUARD: the evidence grant does not widen to the project root, a tracked file or git -C', () => {
      const f = fixture();
      const allowed = rootsFor(f, RUN);
      expect(guard(f, write(join(f.primary, 'tracked.md')), allowed)).toMatchObject(BLOCK);
      expect(guard(f, write(join(f.primary, '.local', 'xezar', 'tasks', OTHER_RUN, 'x.md')), allowed)).toMatchObject(BLOCK);
      expect(guard(f, bash(`echo x >> ${f.primary}/tracked.md`), allowed)).toMatchObject(BLOCK);
      expect(guard(f, bash(`git -C ${f.primary} commit -am x`), allowed)).toMatchObject(BLOCK);
      expect(guard(f, write('notes.md'), allowed)).toBeUndefined();
    });
  });

  describe('Minor 2: every empty or absent input fails closed', () => {
    it('blocks a write without a path, an empty path and a bash call without a command', () => {
      const f = fixture();
      expect(guard(f, { toolName: 'write', input: {} })).toMatchObject(BLOCK);
      expect(guard(f, write(''))).toMatchObject(BLOCK);
      expect(guard(f, { toolName: 'bash', input: {} })).toMatchObject(BLOCK);
    });

    it('blocks when the tool cwd is not the worktree root', () => {
      const f = fixture();
      mkdirSync(join(f.worktree, 'sub'));
      expect(__internals.guardToolCall(f.worktree, join(f.worktree, 'sub'), write('notes.md'), f.primary, [])).toMatchObject(BLOCK);
    });

    it('blocks when the primary checkout is absent or cannot be resolved', () => {
      const f = fixture();
      expect(__internals.guardToolCall(f.worktree, f.worktree, write('notes.md'), undefined, [])).toMatchObject(BLOCK);
      expect(__internals.guardToolCall(f.worktree, f.worktree, write('notes.md'), join(f.home, 'missing'), [])).toMatchObject(BLOCK);
    });
  });

  describe('the pi extension wiring', () => {
    type GuardApi = Parameters<typeof extension>[0];
    type Handler = Parameters<GuardApi['on']>[1];

    function load(flags: Record<string, string | boolean | undefined>): Handler {
      let handler: Handler | undefined;
      extension({
        registerFlag: () => undefined,
        getFlag: (name) => flags[name],
        on: (_event, next) => { handler = next; },
      });
      if (!handler) throw new Error('the extension registered no tool_call handler');
      return handler;
    }

    it('registers a blocking tool_call hook using the explicit root flags', () => {
      const f = fixture();
      const handler = load({ 'xezar-worktree-root': f.worktree, 'xezar-primary-root': f.primary, 'xezar-allowed-roots': JSON.stringify([f.runs]) });
      expect(handler(write(join(f.primary, 'tracked.md')), { cwd: f.worktree })).toMatchObject(BLOCK);
      expect(handler(write('notes.md'), { cwd: f.worktree })).toBeUndefined();
      expect(handler(write(join(f.runs, 'task.handoff.md')), { cwd: f.worktree })).toBeUndefined();
    });

    it.each([
      ['the worktree flag is missing', (f: Fixture) => ({ 'xezar-primary-root': f.primary })],
      ['the worktree flag is empty', (f: Fixture) => ({ 'xezar-worktree-root': '', 'xezar-primary-root': f.primary })],
      ['the primary flag is missing', (f: Fixture) => ({ 'xezar-worktree-root': f.worktree })],
      ['the allowed-roots flag is not a JSON list', (f: Fixture) => ({ 'xezar-worktree-root': f.worktree, 'xezar-primary-root': f.primary, 'xezar-allowed-roots': 'not-json' })],
    ])('fails closed when %s', (_name, flags) => {
      const f = fixture();
      expect(load(flags(f))(write('notes.md'), { cwd: f.worktree })).toMatchObject(BLOCK);
    });
  });
});

describe('pi honours a step bashAllowlist command by command (#856)', () => {
  type GuardApi = Parameters<typeof extension>[0];
  type Handler = Parameters<GuardApi['on']>[1];

  function load(flags: Record<string, string | boolean | undefined>): Handler {
    let handler: Handler | undefined;
    extension({
      registerFlag: () => undefined,
      getFlag: (name) => flags[name],
      on: (_event, next) => { handler = next; },
    });
    if (!handler) throw new Error('the extension registered no tool_call handler');
    return handler;
  }

  /** A worktree run: both the worktree check and the allowlist apply. */
  function worktreeRun(entries: string[]) {
    const f = fixture();
    const handler = load({
      'xezar-worktree-root': f.worktree,
      'xezar-primary-root': f.primary,
      'xezar-bash-allowlist': JSON.stringify(entries),
    });
    return { f, run: (command: string) => handler(bash(command), { cwd: f.worktree }) };
  }

  /** A run with no worktree: the extension is loaded for the allowlist alone. */
  function inPlaceRun(entries: string[]) {
    const handler = load({ 'xezar-bash-allowlist': JSON.stringify(entries) });
    return (command: string) => handler(bash(command), { cwd: tmpdir() });
  }

  it('allows a command that is an entry, or an entry followed by a space', () => {
    const { run } = worktreeRun(['git diff']);
    expect(run('git diff')).toBeUndefined();
    expect(run('git diff --stat')).toBeUndefined();
    // With no worktree the extension is loaded for the allowlist alone and must not fail closed.
    expect(inPlaceRun(['git diff'])('git diff --stat')).toBeUndefined();
  });

  it('refuses a command whose prefix is no entry, including one that only shares its letters', () => {
    const { run } = worktreeRun(['git diff']);
    const refused = run('git difftool');
    expect(refused).toMatchObject(BLOCK);
    expect(refused?.reason).toContain('"git difftool"');
    expect(run('rm -rf build')).toMatchObject(BLOCK);
  });

  it('allows `gh pr comment x --body y` with the entry `gh pr comment`', () => {
    expect(inPlaceRun(['gh pr comment'])('gh pr comment x --body y')).toBeUndefined();
    // a quoted operator is text the program receives, not a second command
    expect(inPlaceRun(['gh pr comment'])('gh pr comment 12 --body "a; b | c > d"')).toBeUndefined();
  });

  it('refuses `git diff; rm x` with the entry `git diff`, naming the failing part and why', () => {
    const refused = inPlaceRun(['git diff'])('git diff; rm x');
    expect(refused).toMatchObject(BLOCK);
    expect(refused?.reason).toContain('"rm x"');
    expect(refused?.reason).toContain('every part of a compound command must match');
  });

  it.each(['git diff && rm x', 'git diff || rm x', 'git diff & rm x', 'git diff\nrm x'])(
    'refuses the compound `%s` because one part matches no entry',
    (command) => {
      expect(inPlaceRun(['git diff'])(command)).toMatchObject(BLOCK);
    },
  );

  it('refuses `gh pr view | tee out`: the `tee out` part matches no entry', () => {
    const refused = inPlaceRun(['gh pr view'])('gh pr view | tee out');
    expect(refused).toMatchObject(BLOCK);
    expect(refused?.reason).toContain('"tee out"');
  });

  it('allows a pipe when every part matches: printf into the verdict-packet writer', () => {
    const run = inPlaceRun(['printf', 'bash .xezar/checks/verdict-packet.sh']);
    expect(run("printf '%s' x | bash .xezar/checks/verdict-packet.sh")).toBeUndefined();
    // the same pipe with only one of the two entries is refused
    expect(inPlaceRun(['printf'])("printf '%s' x | bash .xezar/checks/verdict-packet.sh")).toMatchObject(BLOCK);
  });

  it.each([
    ['git diff $(rm x)', 'rm x'],
    ['git diff `rm x`', 'rm x'],
    ['git diff "$(rm x)"', 'rm x'],
  ])('refuses the substitution in `%s` unless its command matches too', (command, part) => {
    const refused = inPlaceRun(['git diff'])(command);
    expect(refused).toMatchObject(BLOCK);
    expect(refused?.reason).toContain(`"${part}"`);
    expect(inPlaceRun(['git diff', 'rm'])(command)).toBeUndefined();
  });

  it.each(['git diff > out', 'git diff >> out', 'git diff 2>&1', 'git diff &> out', 'git diff $(git log > x)'])(
    'refuses the output redirection in `%s` outright',
    (command) => {
      const refused = inPlaceRun(['git diff', 'git log'])(command);
      expect(refused).toMatchObject(BLOCK);
      expect(refused?.reason).toContain('redirects output');
    },
  );

  it.each([
    ['cat <<EOF\nx\nEOF', 'heredoc'],
    ['git diff <(git log)', 'process substitution'],
    ["git diff 'unclosed", 'unclosed quote'],
    ['git diff $(git log', 'unclosed command substitution'],
  ])('refuses `%s` it cannot read as plain commands (%s)', (command, why) => {
    const refused = inPlaceRun(['git diff', 'git log', 'cat'])(command);
    expect(refused).toMatchObject(BLOCK);
    expect(refused?.reason).toContain(why);
  });

  it('refuses an input redirection `<` like an output one, and allows the same command without it', () => {
    const refused = inPlaceRun(['cat'])('cat < /etc/passwd');
    expect(refused).toMatchObject(BLOCK);
    expect(refused?.reason).toContain('redirects input');
    expect(inPlaceRun(['cat'])('cat file')).toBeUndefined();
    // quoted, it is text the program receives
    expect(inPlaceRun(['gh pr comment'])('gh pr comment 1 --body "a < b"')).toBeUndefined();
  });

  // `-exec rm {} \;` ends in an escaped or `+` terminator, so the splitter keeps it in the `find`
  // part and a bare `find` entry would match it. An argument that runs or deletes is refused by
  // name. A tool whose LEADING word runs another command (`xargs`, `env`, `nice`, `timeout`,
  // `sh -c`, `bash -c`, `eval`) needs no such rule: the part starts with that word, so it is
  // refused unless the list carries that word as an entry.
  it.each([
    ['find . -exec rm -rf {} \\;', '-exec'],
    ['find . -execdir rm {} +', '-execdir'],
    ['find . -ok rm {} \\;', '-ok'],
    ['find . -okdir rm {} \\;', '-okdir'],
    ['find . -name x -delete', '-delete'],
    ["find . '-exec' rm {} +", '-exec'],
    ['find . -fprint out', '-fprint'],
    ['git status && find . -delete', '-delete'],
  ])('refuses `%s` under the entry `find`, naming %s', (command, flag) => {
    const refused = inPlaceRun(['find', 'git status'])(command);
    expect(refused).toMatchObject(BLOCK);
    expect(refused?.reason).toContain(`"${flag}"`);
  });

  it('allows a `find` that only reads, and a quoted `-exec` given to another program', () => {
    expect(inPlaceRun(['find'])('find . -name x')).toBeUndefined();
    expect(inPlaceRun(['find'])("find . -name '*.ts' -type f")).toBeUndefined();
    expect(inPlaceRun(['find'])('find . -name "*.ts" -type f')).toBeUndefined();
    expect(inPlaceRun(['find'])("find . -name '$HOME' -type f")).toBeUndefined();
    expect(inPlaceRun(['find'])('find . -name \\*.ts')).toBeUndefined();
    expect(inPlaceRun(['gh pr comment'])('gh pr comment 1 --body "find -exec rm"')).toBeUndefined();
  });

  // The shell expands a word before `find` sees it, and the guard compares the text it can read.
  // So under a program with a row, a word that the shell would still change – an unquoted `$`,
  // a backtick, `$'…'`, `{`, `}`, `~` or a glob character, or a `$`/backtick inside double
  // quotes – is refused before expansion rather than guessed. A quoted glob stays allowed; an
  // unquoted one (`find . -name *.ts`) is refused (Fable's verification on #861, round 2).
  it.each([
    ['find . -e${HOME:0:0}xec rm -rf {} \\;', '-e${HOME:0:0}xec'],
    ['find . -e$(echo x)ec rm -rf {} \\;', '-e$(echo'],
    ["find . -e$'x'ec rm -rf {} \\;", "-e$'x'ec"],
    ['find sub -d${HOME:0:0}elete', '-d${HOME:0:0}elete'],
    ['find . -e`echo x`ec rm {} +', '-e`echo'],
    ['find . "-e${X}xec" rm {} +', '"-e${X}xec"'],
    ['find . -{ex,}ec rm {} +', '-{ex,}ec'],
    ['find ~ -name x', '~'],
    ['find . -name *.ts', '*.ts'],
    ['find . -name x?', 'x?'],
    ['find . -name [ab]', '[ab]'],
  ])('refuses `%s` under the entry `find`: %s cannot be checked before expansion', (command, word) => {
    const refused = inPlaceRun(['find', 'echo'])(command);
    expect(refused).toMatchObject(BLOCK);
    expect(refused?.reason).toContain(`"${word}"`);
    expect(refused?.reason).toContain('cannot be checked before expansion');
  });

  it('leaves the expansion rule to programs with a row: `git diff $X` and `echo *` stay allowed', () => {
    expect(inPlaceRun(['git diff'])('git diff $X')).toBeUndefined();
    expect(inPlaceRun(['echo'])('echo *')).toBeUndefined();
  });

  it.each(['xargs rm', 'env rm x', 'nice rm x', 'timeout 5 rm x', 'sh -c "rm x"', 'bash -c "rm x"', 'eval "rm x"'])(
    'refuses `find . | %s`: a command-running leading word is an ordinary part that matches no entry',
    (tail) => {
      expect(inPlaceRun(['find'])(`find . | ${tail}`)).toMatchObject(BLOCK);
    },
  );

  it('does not let a comment\'s quote hide the next line\'s command', () => {
    expect(inPlaceRun(['git diff'])("git diff # it's\nrm x\n'")).toMatchObject(BLOCK);
  });

  it('does not let an ANSI-C `\\\'` end the quote early', () => {
    expect(inPlaceRun(['echo'])("echo $'a\\'b'")).toBeUndefined();
    expect(inPlaceRun(['echo'])("echo $'a\\'; rm x'")).toBeUndefined();
    expect(inPlaceRun(['echo'])("echo $'a\\''; rm x")).toMatchObject(BLOCK);
  });

  it('leaves the other tools alone, and still applies the worktree check to an allowed command', () => {
    const { f, run } = worktreeRun(['git']);
    const handler = load({ 'xezar-bash-allowlist': JSON.stringify(['git']) });
    expect(handler(write(join(tmpdir(), 'x')), { cwd: tmpdir() })).toBeUndefined();
    expect(run('git status')).toBeUndefined();
    expect(run(`git -C ${f.primary} status`)).toMatchObject(BLOCK);
  });

  it('fails closed on an allowlist flag that is not `null` or a JSON list of strings, for every tool', () => {
    for (const flag of ['not-json', '[1]', '{}', '"git"', true]) {
      const handler = load({ 'xezar-bash-allowlist': flag });
      expect(handler(bash('git diff'), { cwd: tmpdir() })).toMatchObject(BLOCK);
      expect(handler(write('notes.md'), { cwd: tmpdir() })).toMatchObject(BLOCK);
    }
  });

  // Fable's table on #861: `[]` must lock the shell down exactly as `["  "]` does, on a run with a
  // worktree and on one without, and a missing flag must not read as "no allowlist".
  it.each([
    ['[]', '[]'],
    ['["  "]', '["  "]'],
  ])('refuses every bash command, and nothing else, with the list %s', (_name, flag) => {
    const inPlace = load({ 'xezar-bash-allowlist': flag });
    const refused = inPlace(bash('git diff'), { cwd: tmpdir() });
    expect(refused).toMatchObject(BLOCK);
    expect(refused?.reason).toContain('has no entry');
    expect(inPlace(bash('rm -f sub/sentinel.txt'), { cwd: tmpdir() })).toMatchObject(BLOCK);
    expect(inPlace(write(join(tmpdir(), 'x')), { cwd: tmpdir() })).toBeUndefined();
    const f = fixture();
    const worktree = load({ 'xezar-worktree-root': f.worktree, 'xezar-primary-root': f.primary, 'xezar-bash-allowlist': flag });
    expect(worktree(bash('rm -f sub/sentinel.txt'), { cwd: f.worktree })).toMatchObject(BLOCK);
    expect(worktree(write('notes.md'), { cwd: f.worktree })).toBeUndefined();
  });

  it('reads `null` as "this step has no allowlist" and refuses bash when the flag is absent', () => {
    const f = fixture();
    const roots = { 'xezar-worktree-root': f.worktree, 'xezar-primary-root': f.primary };
    expect(load({ ...roots, 'xezar-bash-allowlist': 'null' })(bash('rm -f sub/sentinel.txt'), { cwd: f.worktree })).toBeUndefined();
    const absent = load(roots);
    const refused = absent(bash('rm -f sub/sentinel.txt'), { cwd: f.worktree });
    expect(refused).toMatchObject(BLOCK);
    expect(refused?.reason).toContain('flag is missing');
    // the missing flag says nothing about the other tools, which keep the worktree check
    expect(absent(write('notes.md'), { cwd: f.worktree })).toBeUndefined();
  });

  it('keeps failing closed when only one worktree flag is present, allowlist or not', () => {
    const f = fixture();
    const handler = load({ 'xezar-primary-root': f.primary, 'xezar-bash-allowlist': '["git diff"]' });
    expect(handler(bash('git diff'), { cwd: f.worktree })).toMatchObject(BLOCK);
  });
});
