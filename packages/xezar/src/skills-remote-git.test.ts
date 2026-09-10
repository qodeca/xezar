import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SkillsRepoSource } from './config.ts';
import {
  bareDirFor,
  ensureBareClone,
  fetchAll,
  isSafeRef,
  listRemoteSkills,
  materializeSkillDir,
  readRemoteSkill,
  safeRemoteFor,
} from './skills-remote.ts';
import type { Skill } from './skills.ts';

/**
 * The git half of team skills (spec 005, hardened by #428) — everything
 * `skills-remote.test.ts` cannot reach, because it only exercises the pure helpers.
 *
 * NOTHING here touches the network. The "remote" is a real git repository in a temp dir,
 * bare-cloned by the module itself into its own cache location, which is relocated by pinning
 * `HOME` — the same fixture shape `server/skills-api.test.ts` uses, for the same reason.
 */

/** `~/.cache/xez/skills/…` resolves through `os.homedir()`, so the pin has to happen before
 *  the imports above are evaluated. `XEZ_HOME` does not cover that path. */
const fixedHome = vi.hoisted(() => {
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const base = (process.env.TMPDIR || process.env.TEMP || '/tmp').replace(/[\\/]+$/, '');
  const home = `${base}/xez-skills-remote-home-${process.pid}`;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return { home, previous };
});

afterAll(() => {
  if (fixedHome.previous.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = fixedHome.previous.HOME;
  if (fixedHome.previous.USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = fixedHome.previous.USERPROFILE;
  rmSync(fixedHome.home, { recursive: true, force: true });
});

// ---- the source-string guard (#428) ------------------------------------------------------

describe('safeRemoteFor', () => {
  it('rewrites the GitHub shorthand to its canonical https remote', () => {
    expect(safeRemoteFor('open-mercato/skills')).toBe('https://github.com/open-mercato/skills.git');
    expect(safeRemoteFor('  qodeca/xezar  ')).toBe('https://github.com/qodeca/xezar.git');
  });

  it.each([
    'https://github.com/open-mercato/skills.git',
    'http://internal.example/skills.git',
    'ssh://git@github.com/open-mercato/skills.git',
    'git://example.com/skills.git',
    'file:///srv/skills.git',
  ])('passes an allowlisted URL scheme through untouched: %s', (value) => {
    expect(safeRemoteFor(value)).toBe(value);
  });

  it('passes the scp-like spelling through', () => {
    expect(safeRemoteFor('git@github.com:open-mercato/skills.git')).toBe(
      'git@github.com:open-mercato/skills.git'
    );
  });

  it.each(['/srv/skills', './rel/skills', '../up/skills'])(
    'keeps a local path a local path: %s',
    (value) => {
      // Matched BEFORE the owner/name shorthand: `.` and `-` are in the shorthand charset, so
      // `./rel` would otherwise be rewritten to `https://github.com/./rel.git`.
      expect(safeRemoteFor(value)).toBe(value);
    }
  );

  it('expands `~/` itself, because execFile runs git with no shell to do it', () => {
    expect(safeRemoteFor('~/code/skills')).toBe(join(homedir(), 'code/skills'));
  });

  it.each(['C:\\repo\\skills', 'D:/repo/skills'])(
    'keeps a Windows drive path working — BC §5 protects the source shape: %s',
    (value) => {
      expect(safeRemoteFor(value)).toBe(value);
    }
  );

  it.each([
    // The remote-helper transports: `ext::` is arbitrary command execution.
    ['ext::sh -c "touch /tmp/pwned"', 'remote-helper syntax'],
    ['fd::7', 'remote-helper syntax'],
    ['owner/name::evil', 'remote-helper syntax anywhere in the value'],
    // A leading dash is an OPTION to git, not a repo — argument injection.
    ['--upload-pack=touch /tmp/pwned', 'leading dash'],
    ['-c', 'leading dash'],
    // Any other scheme.
    ['ftp://example.com/skills.git', 'unlisted scheme'],
    ['javascript://example.com/x', 'unlisted scheme'],
    ['EXT://example.com/x', 'unlisted scheme, case-insensitively'],
    // Not a repo reference at all.
    ['', 'empty'],
    ['   ', 'blank'],
    ['just-a-word', 'no owner'],
    ['owner/name/extra', 'too many segments'],
    ['owner/na me', 'a space is not in the shorthand charset'],
  ])('refuses %j (%s)', (value) => {
    expect(safeRemoteFor(value)).toBeNull();
  });
});

describe('isSafeRef', () => {
  it.each(['main', 'v1.2.3', 'refs/heads/main', 'a'.repeat(256), 'a'.repeat(40)])(
    'accepts %s',
    (ref) => {
      expect(isSafeRef(ref)).toBe(true);
    }
  );

  it.each([
    ['', 'empty'],
    ['-x', 'a leading dash would be a git option'],
    ['a..b', 'a range, not a ref'],
    ['main:evil', 'the colon would split `${ref}:${path}` in git show'],
    ['main^{commit}', 'revision metacharacters'],
    ['main space', 'not in the ref-name charset'],
    ['a'.repeat(257), 'too long'],
  ])('refuses %j (%s)', (ref) => {
    expect(isSafeRef(ref)).toBe(false);
  });
});

// ---- the real-git fixture -----------------------------------------------------------------

/** A fixed identity, so every fixture commit works on a bare CI machine. */
const GIT_ID = ['-c', 'user.email=t@test', '-c', 'user.name=t'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
}

/** macOS hands out `/var/folders/…`, a symlink; git always answers resolved. */
function scratch(prefix: string): string {
  return mkdtempSync(join(realpathSync(tmpdir()), prefix));
}

function write(root: string, relPath: string, content: string): void {
  const path = join(root, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function withFrontmatter(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

const REF = 'main';

describe('team skills read out of a real bare clone', () => {
  let source: string;
  let repoRoot: string;
  let src: SkillsRepoSource;

  beforeEach(async () => {
    mkdirSync(fixedHome.home, { recursive: true });
    source = scratch('xez-skills-remote-source-');
    repoRoot = scratch('xez-skills-remote-repo-');

    git(source, 'init', '-q', '-b', REF);
    // One file per discovery convention `matchSkillPath` knows.
    write(source, '.xezar/skills/named.md', withFrontmatter('named', 'from frontmatter', 'NAMED BODY'));
    write(source, '.xezar/skills/by-basename.md', 'NO FRONTMATTER BODY\n');
    write(source, '.ai/xezar/skills/legacy.md', withFrontmatter('legacy', 'legacy path', 'LEGACY BODY'));
    write(source, 'commands/cmd-skill.md', 'COMMAND BODY\n');
    write(source, 'dir-skill/SKILL.md', withFrontmatter('ignored-name', 'a directory skill', 'DIR BODY'));
    write(source, 'dir-skill/references/notes.md', 'REFERENCE NOTES\n');
    write(source, 'dir-skill/references/deep/more.md', 'DEEPER NOTES\n');
    // Neither a skill nor a command — must not appear in the listing.
    write(source, 'README.md', '# not a skill\n');
    git(source, 'add', '-A');
    git(source, 'commit', '-q', '-m', 'skills');

    src = { repo: source, ref: REF };
    // The module does the cloning, so the clone path itself is under test.
    await ensureBareClone(source);
  });

  afterEach(() => {
    for (const dir of [source, repoRoot, bareDirFor(source)]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('ensureBareClone', () => {
    it('lands the clone exactly where bareDirFor says, without a checkout', () => {
      const bareDir = bareDirFor(source);
      expect(existsSync(join(bareDir, 'HEAD'))).toBe(true);
      // Bare: no working tree, so nothing was checked out into the cache.
      expect(existsSync(join(bareDir, '.git'))).toBe(false);
      expect(existsSync(join(bareDir, 'README.md'))).toBe(false);
    });

    it('reports the second call as a cache hit rather than re-cloning', async () => {
      await expect(ensureBareClone(source)).resolves.toEqual({
        bareDir: bareDirFor(source),
        created: false,
      });
    });

    it('refuses an unsafe source before touching the cache, and warns once per process', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const evil = 'ext::sh -c "touch /tmp/pwned"';
        await expect(ensureBareClone(evil)).rejects.toThrow(/refusing unsafe skills repo remote/);
        await expect(ensureBareClone(evil)).rejects.toThrow(/refusing unsafe skills repo remote/);

        // Everything else in this module degrades silently; a refusal means the CONFIG is wrong,
        // so the operator has to be told — but only once, since this runs on every cockpit open.
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain('skillsRepos');
        expect(existsSync(join(bareDirFor(evil), 'HEAD'))).toBe(false);
      } finally {
        warn.mockRestore();
      }
    });

    it('surfaces a clone failure rather than leaving a half-usable cache', async () => {
      const missing = join(source, 'no-such-repo');
      await expect(ensureBareClone(missing)).rejects.toThrow(/git clone --bare/);
      rmSync(bareDirFor(missing), { recursive: true, force: true });
    });
  });

  describe('listRemoteSkills', () => {
    it('finds one skill per discovery convention and ignores everything else', async () => {
      const skills = await listRemoteSkills(src);

      expect(skills.map((s) => s.name).sort()).toEqual([
        'by-basename',
        'cmd-skill',
        'dir-skill',
        'legacy',
        'named',
      ]);
    });

    it('names a SKILL.md after its DIRECTORY, not after its frontmatter', async () => {
      const skills = await listRemoteSkills(src);
      const dirSkill = skills.find((s) => s.name === 'dir-skill');

      // The frontmatter says `ignored-name`; the janitor convention is the parent directory.
      expect(dirSkill?.name).toBe('dir-skill');
      expect(skills.some((s) => s.name === 'ignored-name')).toBe(false);
      expect(dirSkill?.team?.dir).toBe(true);
    });

    it('falls back to the basename when the markdown carries no frontmatter name', async () => {
      const skills = await listRemoteSkills(src);
      const plain = skills.find((s) => s.name === 'by-basename');

      expect(plain?.body.trim()).toBe('NO FRONTMATTER BODY');
      expect(plain?.description).toBeUndefined();
      expect(plain?.team?.dir).toBe(false);
    });

    it('records the immutable commit, so a listing and its bodies cannot drift', async () => {
      const head = git(source, 'rev-parse', 'HEAD').trim();
      const skills = await listRemoteSkills(src);

      // The ref is a moving name; what gets recorded is the SHA it named at read time. A
      // concurrent refresh can move the branch head without this listing changing underneath.
      for (const skill of skills) expect(skill.team?.commit).toBe(head);
      expect(skills[0]?.source).toBe('team');
      const named = skills.find((s) => s.name === 'named');
      expect(named?.path).toBe(`${source}@${REF}:.xezar/skills/named.md`);
      expect(named?.description).toBe('from frontmatter');
      expect(named?.body.trim()).toBe('NAMED BODY');
    });

    it('is empty for a repo that has never been cloned', async () => {
      await expect(listRemoteSkills({ repo: '/nowhere/at/all', ref: REF })).resolves.toEqual([]);
    });

    it('falls back to HEAD for a branch that no longer exists', async () => {
      // `HEAD` is the last resolve candidate, so a renamed or deleted branch degrades to the
      // repo's default rather than making every team skill vanish.
      const names = (await listRemoteSkills({ ...src, ref: 'no-such-branch-anywhere' })).map(
        (s) => s.name
      );
      expect(names.sort()).toEqual((await listRemoteSkills(src)).map((s) => s.name).sort());
    });

    it('is empty for a ref that is refused outright', async () => {
      // An unsafe ref never reaches git at all — no fallback, nothing listed.
      await expect(listRemoteSkills({ ...src, ref: '--output=/tmp/pwned' })).resolves.toEqual([]);
      await expect(listRemoteSkills({ ...src, ref: 'main:evil' })).resolves.toEqual([]);
    });

    it('reads at a pinned commit SHA, and refuses one the repo does not have', async () => {
      const head = git(source, 'rev-parse', 'HEAD').trim();

      expect((await listRemoteSkills({ ...src, ref: head })).length).toBeGreaterThan(0);
      // Pinned means pinned: a SHA this repo does not contain must NOT fall back to HEAD, which
      // is the whole point of pinning against a force-push or a supply-chain swap.
      await expect(listRemoteSkills({ ...src, ref: 'b'.repeat(40) })).resolves.toEqual([]);
    });
  });

  describe('readRemoteSkill', () => {
    it('reads one file at the source ref', async () => {
      await expect(readRemoteSkill(src, 'README.md')).resolves.toBe('# not a skill\n');
    });

    it('is null for a path the commit does not contain', async () => {
      await expect(readRemoteSkill(src, 'nope.md')).resolves.toBeNull();
    });

    it('is null for an unsafe ref and for a repo with no clone', async () => {
      await expect(readRemoteSkill({ ...src, ref: '-x' }, 'README.md')).resolves.toBeNull();
      await expect(
        readRemoteSkill({ repo: '/nowhere/at/all', ref: REF }, 'README.md')
      ).resolves.toBeNull();
    });
  });

  describe('fetchAll', () => {
    it('brings a commit made after the clone into the cached bare repo', async () => {
      write(source, '.xezar/skills/added-later.md', withFrontmatter('added-later', 'new', 'NEW BODY'));
      git(source, 'add', '-A');
      git(source, 'commit', '-q', '-m', 'add one');

      // The stale clone still shows the old listing…
      expect((await listRemoteSkills(src)).some((s) => s.name === 'added-later')).toBe(false);
      await fetchAll(bareDirFor(source));
      // …and the fetch is what makes a worktree review stop reading a stale template.
      expect((await listRemoteSkills(src)).some((s) => s.name === 'added-later')).toBe(true);
    });

    it('throws when there is nothing to fetch from', async () => {
      const orphan = scratch('xez-skills-remote-orphan-');
      git(orphan, 'init', '-q', '--bare');
      try {
        await expect(fetchAll(orphan)).rejects.toThrow(/git fetch failed/);
      } finally {
        rmSync(orphan, { recursive: true, force: true });
      }
    });
  });

  describe('materializeSkillDir', () => {
    const dirSkill = async (): Promise<Skill> => {
      const skills = await listRemoteSkills(src);
      return skills.find((s) => s.name === 'dir-skill')!;
    };

    it('copies the whole directory out of the bare clone, references and all', async () => {
      expect(await materializeSkillDir(repoRoot, await dirSkill())).toBe(true);

      const dest = join(repoRoot, '.claude', 'skills', 'dir-skill');
      expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toContain('DIR BODY');
      // The references are the reason this exists at all: claude reads them off DISK, so a
      // body-only copy would leave every `references/…` link dangling.
      expect(readFileSync(join(dest, 'references', 'notes.md'), 'utf8')).toBe('REFERENCE NOTES\n');
      expect(readFileSync(join(dest, 'references', 'deep', 'more.md'), 'utf8')).toBe('DEEPER NOTES\n');
    });

    it("keeps the copy out of the user's git via info/exclude", async () => {
      git(repoRoot, 'init', '-q', '-b', 'main');
      expect(await materializeSkillDir(repoRoot, await dirSkill())).toBe(true);

      const exclude = readFileSync(join(repoRoot, '.git', 'info', 'exclude'), 'utf8');
      expect(exclude.split('\n')).toContain('.claude/skills/dir-skill/');
    });

    it('adds the exclude entry at most once', async () => {
      git(repoRoot, 'init', '-q', '-b', 'main');
      await materializeSkillDir(repoRoot, await dirSkill());
      await materializeSkillDir(repoRoot, await dirSkill());

      const lines = readFileSync(join(repoRoot, '.git', 'info', 'exclude'), 'utf8')
        .split('\n')
        .filter((line) => line === '.claude/skills/dir-skill/');
      expect(lines).toHaveLength(1);
    });

    it('still materializes when the repo is not a git repo at all', async () => {
      // The exclude write is non-fatal by design — a plain directory has no `.git` to write to,
      // and the skill still has to land on disk.
      expect(await materializeSkillDir(repoRoot, await dirSkill())).toBe(true);
      expect(existsSync(join(repoRoot, '.claude', 'skills', 'dir-skill', 'SKILL.md'))).toBe(true);
    });

    it('refuses anything that is not a directory skill', async () => {
      const skills = await listRemoteSkills(src);
      const flat = skills.find((s) => s.name === 'named')!;

      expect(await materializeSkillDir(repoRoot, flat)).toBe(false);
      expect(await materializeSkillDir(repoRoot, { ...flat, team: undefined })).toBe(false);
      expect(existsSync(join(repoRoot, '.claude'))).toBe(false);
    });

    it('refuses when the clone is gone, or the ref cannot be resolved', async () => {
      const skill = await dirSkill();

      expect(
        await materializeSkillDir(repoRoot, {
          ...skill,
          team: { ...skill.team!, repo: '/nowhere/at/all' },
        })
      ).toBe(false);
      expect(
        await materializeSkillDir(repoRoot, { ...skill, team: { ...skill.team!, ref: '-x' } })
      ).toBe(false);
      expect(existsSync(join(repoRoot, '.claude'))).toBe(false);
    });

    it('refuses when the directory holds no files to write', async () => {
      const skill = await dirSkill();

      // A team record pointing at a path this commit does not have: `ls-tree` lists nothing, so
      // there is nothing to materialize and the caller must be told so rather than shown an
      // empty directory.
      expect(
        await materializeSkillDir(repoRoot, {
          ...skill,
          team: { ...skill.team!, path: 'no-such-dir/SKILL.md' },
        })
      ).toBe(false);
      expect(existsSync(join(repoRoot, '.claude', 'skills', 'dir-skill'))).toBe(false);
    });
  });
});
