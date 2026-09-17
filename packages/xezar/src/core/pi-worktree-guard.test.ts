import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import extension, { __internals } from '../../scripts/pi-worktree-guard.ts';

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
      ['a known variable outside the primary', (f: Fixture) => {
        process.env.XEZ_GUARD_OUTSIDE = f.outside;
        return 'cd "$XEZ_GUARD_OUTSIDE" && ls';
      }],
    ])('allows %s', (_name, command) => {
      const f = fixture();
      try {
        expect(guard(f, bash(command(f)))).toBeUndefined();
      } finally {
        delete process.env.XEZ_GUARD_OUTSIDE;
      }
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
