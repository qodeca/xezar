import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_TAGS_MAX, PROJECT_TAG_MAX_LENGTH } from '@qodeca/xezar-contract';
import { projectStateLayout, setActiveStateLayout } from '../state-layout.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from './config.ts';
import { readStoredCliSettings, rememberLastListen } from './port-memory.ts';
import {
  allocateProjectSlug,
  clearProjectProbeCache,
  instanceBootLine,
  instanceModeInForce,
  listProjects,
  normalizeProjectTags,
  registerProject,
  removeProject,
  shouldRegisterProject,
} from './projects.ts';

/**
 * Project registry ops (spec 2026-07-20-multi-project-workspace, step 1.3):
 * realpath/symlink/trailing-slash dedupe, slug collision suffixes, the
 * reserved-slug skip (`default` → `default-2`), status probing
 * (ok/missing/not-git + branch), and the promise that register/remove never
 * write a byte inside the repo itself.
 */
describe('workspace projects', () => {
  const originalHome = process.env.XEZ_HOME;
  let home: string;
  let repos: string;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'xez-workspace-'));
    repos = mkdtempSync(join(realpathSync(tmpdir()), 'xez-repos-'));
    process.env.XEZ_HOME = home; // paths.ts sends all workspace paths here
    clearProjectProbeCache();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repos, { recursive: true, force: true });
  });

  const makeDir = (...segments: string[]): string => {
    const dir = join(repos, ...segments);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  const makeRepo = (...segments: string[]): string => {
    const dir = makeDir(...segments);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'],
      { cwd: dir },
    );
    return dir;
  };

  describe('registerProject', () => {
    it('registers a new root with slug, name, timestamps and source', async () => {
      const root = makeDir('xezar');
      const entry = await registerProject(root);
      expect(entry).toMatchObject({ id: 'xezar', root, name: 'xezar', source: 'local' });
      expect(entry.addedAt).not.toBe('');
      expect(entry.lastOpenedAt).toBe(entry.addedAt);
      expect((await loadWorkspaceConfig()).projects).toEqual([entry]);
    });

    it('dedupes a trailing-slash spelling to the existing entry and bumps lastOpenedAt', async () => {
      const root = makeDir('api');
      const first = await registerProject(root);
      const again = await registerProject(`${root}/`);
      expect(again.id).toBe(first.id);
      expect(again.addedAt).toBe(first.addedAt);
      expect(Date.parse(again.lastOpenedAt)).toBeGreaterThanOrEqual(Date.parse(first.lastOpenedAt));
      expect((await loadWorkspaceConfig()).projects).toHaveLength(1);
    });

    it('dedupes a symlinked path to the realpath entry', async () => {
      const root = makeDir('real-repo');
      const link = join(repos, 'linked-repo');
      symlinkSync(root, link);
      const first = await registerProject(root);
      const viaLink = await registerProject(link);
      expect(viaLink.id).toBe(first.id);
      expect(viaLink.root).toBe(first.root);
      expect((await loadWorkspaceConfig()).projects).toHaveLength(1);
    });

    it('suffixes colliding slugs numerically (web, web-2)', async () => {
      const a = await registerProject(makeDir('one', 'web'));
      const b = await registerProject(makeDir('two', 'web'));
      const c = await registerProject(makeDir('three', 'web'));
      expect(a.id).toBe('web');
      expect(b.id).toBe('web-2');
      expect(c.id).toBe('web-3');
    });

    it('never allocates a reserved slug — a repo named default/ becomes default-2', async () => {
      for (const reserved of ['default', 'new', 'settings', 'api', 'p', 'assets']) {
        const entry = await registerProject(makeDir('reserved', reserved));
        expect(entry.id).toBe(`${reserved}-2`);
      }
    });

    it('slugifies ugly basenames and keeps a checkout source', async () => {
      const entry = await registerProject(makeDir('My Repo!.git'), 'checkout');
      expect(entry.id).toBe('my-repo-git');
      expect(entry.source).toBe('checkout');
    });

    it('never writes any file inside the repo', async () => {
      const root = makeDir('untouched');
      writeFileSync(join(root, 'keep.txt'), 'keep', 'utf8');
      await registerProject(root);
      expect(readdirSync(root)).toEqual(['keep.txt']);
    });
  });

  /**
   * The guard half of #600 defect A: the DEFAULT (global) layout keeps writing
   * per-machine facts into `~/.xezar/config.json`, byte for byte as before.
   * This row passes with and without the single-project fix, which is the point
   * of it — it pins the behaviour the mode must not change.
   */
  describe('per-machine facts in the global layout (control)', () => {
    it('still writes lastOpenedAt and lastListen into the per-user config', async () => {
      const root = makeDir('machine-facts');
      const entry = await registerProject(root);
      await rememberLastListen(entry.id, 4321, '127.0.0.1');

      const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
        projects: { id: string; lastOpenedAt: string; lastListen: unknown }[];
      };
      expect(config.projects).toHaveLength(1);
      expect(config.projects[0]!.id).toBe(entry.id);
      expect(config.projects[0]!.lastOpenedAt).toBe(entry.lastOpenedAt);
      expect(config.projects[0]!.lastListen).toEqual({
        port: 4321,
        host: '127.0.0.1',
        observedAt: expect.any(String),
      });
    });
  });

  describe('allocateProjectSlug', () => {
    it('falls back to "project" for a degenerate basename', () => {
      expect(allocateProjectSlug('/tmp/日本語', [])).toBe('project');
    });

    it('keeps suffixed slugs within the 64-char id cap', () => {
      const long = 'a'.repeat(80);
      const first = allocateProjectSlug(`/tmp/${long}`, []);
      expect(first).toBe('a'.repeat(64));
      const second = allocateProjectSlug(`/tmp/${long}`, [first]);
      expect(second).toBe(`${'a'.repeat(62)}-2`);
      expect(second).toHaveLength(64);
    });
  });

  describe('listProjects', () => {
    it('keeps default reads unchanged and pins explicit reads without pruning the registry', async () => {
      const first = await registerProject(makeDir('first'));
      const second = await registerProject(makeDir('second'));

      expect((await listProjects()).map((project) => project.id)).toEqual([first.id, second.id]);
      expect((await listProjects({ projectId: second.id })).map((project) => project.id)).toEqual([
        second.id,
      ]);
      expect((await loadWorkspaceConfig()).projects.map((project) => project.id)).toEqual([
        first.id,
        second.id,
      ]);
    });

    it('returns an empty pinned read when the selected id is not registered', async () => {
      await registerProject(makeDir('existing'));
      expect(await listProjects({ projectId: 'unknown' })).toEqual([]);
    });

    it('keeps boot registration self-healing while reads are pinned', async () => {
      const hidden = await registerProject(makeDir('hidden'));
      const boot = await registerProject(makeDir('boot'));

      expect((await listProjects({ projectId: boot.id })).map((project) => project.id)).toEqual([
        boot.id,
      ]);
      const registeredAgain = await registerProject(boot.root);
      expect(registeredAgain.id).toBe(boot.id);
      expect((await loadWorkspaceConfig()).projects.map((project) => project.id)).toEqual([
        hidden.id,
        boot.id,
      ]);
    });

    it('reports a git repo as ok with its current branch', async () => {
      const root = makeRepo('gitful');
      await registerProject(root);
      const [entry] = await listProjects();
      expect(entry).toMatchObject({ id: 'gitful', status: 'ok', branch: 'main' });
    });

    it('classifies a github.com remote as the github forge (#698)', async () => {
      const root = makeRepo('forged');
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/forged.git'], { cwd: root });
      await registerProject(root);
      const [entry] = await listProjects();
      expect(entry).toMatchObject({ status: 'ok', forge: 'github' });
    });

    it('omits forge for a non-github remote and for a remote-less repo', async () => {
      const gitlab = makeRepo('lab');
      execFileSync('git', ['remote', 'add', 'origin', 'git@gitlab.com:acme/lab.git'], { cwd: gitlab });
      const bare = makeRepo('loner');
      await registerProject(gitlab);
      await registerProject(bare);
      const entries = await listProjects();
      expect(entries.every((entry) => entry.forge === undefined)).toBe(true);
    });

    it('reports a deleted root as missing (after the probe TTL cache is cleared)', async () => {
      const root = makeDir('doomed');
      await registerProject(root);
      rmSync(root, { recursive: true, force: true });
      clearProjectProbeCache();
      const [entry] = await listProjects();
      expect(entry?.status).toBe('missing');
      expect(entry?.branch).toBeUndefined();
    });

    it('reports an existing non-git dir as not-git', async () => {
      await registerProject(makeDir('plain-folder'));
      const [entry] = await listProjects();
      expect(entry?.status).toBe('not-git');
      expect(entry?.branch).toBeUndefined();
    });

    it('serves a repeat render from the TTL cache instead of re-probing', async () => {
      const root = makeDir('cached');
      await registerProject(root);
      expect((await listProjects())[0]?.status).toBe('not-git');
      rmSync(root, { recursive: true, force: true });
      // Within the TTL the stale probe is served (no fs/git work per render)…
      expect((await listProjects())[0]?.status).toBe('not-git');
      // …and a cleared cache sees reality again.
      clearProjectProbeCache();
      expect((await listProjects())[0]?.status).toBe('missing');
    });
  });

  describe('removeProject', () => {
    it('unregisters by id and leaves every repo file untouched', async () => {
      const root = makeRepo('kept-repo');
      writeFileSync(join(root, 'precious.txt'), 'data', 'utf8');
      const before = readdirSync(root).sort();
      const entry = await registerProject(root);
      expect(await removeProject(entry.id)).toBe(true);
      expect((await loadWorkspaceConfig()).projects).toEqual([]);
      expect(readdirSync(root).sort()).toEqual(before);
      expect(execFileSync('git', ['-C', root, 'log', '--oneline'], { encoding: 'utf8' })).toContain('init');
    });

    it('returns false for an unknown id and keeps other entries', async () => {
      const entry = await registerProject(makeDir('survivor'));
      expect(await removeProject('no-such-project')).toBe(false);
      expect((await loadWorkspaceConfig()).projects.map((p) => p.id)).toEqual([entry.id]);
    });
  });

  describe('shouldRegisterProject (boot registration guards)', () => {
    it('allows a normal repo root', async () => {
      expect(await shouldRegisterProject(makeRepo('normal-repo'))).toBe(true);
    });

    it('suppresses a xezar task worktree root', async () => {
      const worktree = makeDir('host-repo', '.local', 'xezar', 'worktrees', 'abc12345');
      expect(await shouldRegisterProject(worktree)).toBe(false);
    });

    it('suppresses a repo nested deeper inside a task worktree', async () => {
      const nested = join(repos, 'host', '.local', 'xezar', 'worktrees', 'run-1', 'sub', 'repo');
      // Path need not exist — normalizeRoot degrades to resolve(); the guard
      // must still recognize the worktree marker on the raw spelling.
      expect(await shouldRegisterProject(nested)).toBe(false);
    });

    it('does not suppress a repo merely named like the marker pieces', async () => {
      expect(await shouldRegisterProject(makeDir('xezar-worktrees'))).toBe(true);
    });

    it('suppresses the home directory itself, in any spelling', async () => {
      expect(await shouldRegisterProject(homedir())).toBe(false);
      expect(await shouldRegisterProject(`${homedir()}/`)).toBe(false);
    });
  });

  it('exposes the remote as a credential-free web root', async () => {
    const root = makeRepo('linked');
    execFileSync('git', ['remote', 'add', 'origin', 'https://tok3n:x@github.com/acme/linked.git'], {
      cwd: root,
    });
    await registerProject(root);
    clearProjectProbeCache();

    const listed = (await listProjects())[0];
    // Rebuilt from the parsed remote, so the token in it cannot reach the cockpit.
    expect(listed?.repoUrl).toBe('https://github.com/acme/linked');
    expect(listed?.forge).toBe('github');
  });

  it('omits the web root for a repo with no forge remote', async () => {
    const root = makeRepo('local-only');
    execFileSync('git', ['remote', 'add', 'origin', '/srv/git/local-only.git'], { cwd: root });
    await registerProject(root);
    clearProjectProbeCache();

    const listed = (await listProjects())[0];
    expect(listed?.repoUrl).toBeUndefined();
    expect(listed?.forge).toBeUndefined();
  });

  /**
   * The one spelling rule for grouping tags. Case-insensitive dedupe is the load-bearing part:
   * tags exist to be a GROUPING key on the global Tasks page, and `API` beside `api` splitting
   * one group in two is exactly the failure this prevents.
   */
  describe('normalizeProjectTags', () => {
    it('trims, drops empties, and sorts', () => {
      expect(normalizeProjectTags([' web ', 'api', '', '   '])).toEqual(['api', 'web']);
    });

    it('dedupes case-insensitively, keeping the first spelling', () => {
      expect(normalizeProjectTags(['Storefront', 'storefront', 'STOREFRONT'])).toEqual([
        'Storefront',
      ]);
    });

    it('truncates an over-long tag rather than dropping it', () => {
      const long = 'x'.repeat(PROJECT_TAG_MAX_LENGTH + 10);
      expect(normalizeProjectTags([long])).toEqual(['x'.repeat(PROJECT_TAG_MAX_LENGTH)]);
    });

    it('caps the list', () => {
      const many = Array.from({ length: PROJECT_TAGS_MAX + 5 }, (_, i) => `tag-${i}`);
      expect(normalizeProjectTags(many)).toHaveLength(PROJECT_TAGS_MAX);
    });

    it('answers undefined — never [] — for nothing to store', () => {
      expect(normalizeProjectTags(undefined)).toBeUndefined();
      expect(normalizeProjectTags(null)).toBeUndefined();
      expect(normalizeProjectTags([])).toBeUndefined();
      expect(normalizeProjectTags(['  '])).toBeUndefined();
    });
  });

  it('round-trips tags through the registry', async () => {
    const root = makeDir('tagged');
    const entry = await registerProject(root);
    await mergeWriteWorkspaceConfig((config) => {
      const stored = config.projects.find((p) => p.id === entry.id);
      if (stored) stored.tags = ['api', 'storefront'];
    });
    clearProjectProbeCache();
    const listed = (await listProjects()).find((p) => p.id === entry.id);
    expect(listed?.tags).toEqual(['api', 'storefront']);
  });

  it('drops a malformed tag list per key, keeping the rest of the entry', async () => {
    const root = makeDir('bad-tags');
    const entry = await registerProject(root);
    await mergeWriteWorkspaceConfig((config) => {
      const stored = config.projects.find((p) => p.id === entry.id);
      // A hand-edited config. The per-key `.catch` must degrade the tags to "untagged"
      // rather than evicting the whole project from the registry.
      if (stored) (stored as { tags?: unknown }).tags = 'storefront';
    });
    const listed = (await listProjects()).find((p) => p.id === entry.id);
    expect(listed).toBeDefined();
    expect(listed?.tags).toBeUndefined();
  });
});

/**
 * #600 release-candidate defect A: in the single-project layout the committed
 * `<project>/.xezar/workspace.json` is the file the guide tells users to
 * commit, so a launch must not rewrite it with per-machine facts. The rows here
 * are the regression; the global-layout control above is the guard that passes
 * both ways.
 */
describe('single-project layout — per-machine facts stay out of the committed file (#600 defect A)', () => {
  let projectRoot: string;
  let workspacePath: string;
  let committed: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(realpathSync(tmpdir()), 'xez-sp-facts-'));
    mkdirSync(join(projectRoot, '.xezar'), { recursive: true });
    workspacePath = join(projectRoot, '.xezar', 'workspace.json');
    // A committed file as a clone carries it: ONE row for another machine's
    // folder of the same name, none for this folder, and no per-machine keys.
    committed = `${JSON.stringify(
      {
        schemaVersion: 1,
        projects: [
          {
            id: allocateProjectSlug(projectRoot, []),
            root: join(projectRoot, '..', 'elsewhere', basename(projectRoot)),
            name: 'Another machine',
            addedAt: '2026-01-01T00:00:00.000Z',
            source: 'local',
          },
        ],
      },
      null,
      2,
    )}\n`;
    writeFileSync(workspacePath, committed, 'utf8');
    setActiveStateLayout(projectStateLayout(projectRoot));
  });

  afterEach(() => {
    setActiveStateLayout(null);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('registerProject twice and rememberLastListen once leave the committed file byte-identical', async () => {
    const first = await registerProject(projectRoot);
    const second = await registerProject(projectRoot);
    expect(second.id).toBe(first.id);

    await rememberLastListen(first.id, 4323, '127.0.0.1');

    expect(readFileSync(workspacePath, 'utf8')).toBe(committed);
  });

  it('still remembers the port across a fresh read, without writing it into the committed file', async () => {
    const entry = await registerProject(projectRoot);
    await rememberLastListen(entry.id, 4323, '127.0.0.1');

    const stored = await readStoredCliSettings(entry.id);
    expect(stored.rememberedPort).toBe(4323);
    expect(readFileSync(workspacePath, 'utf8')).toBe(committed);
  });

  it('the derived row id is allocated against the STORED ids, never the empty set', async () => {
    // No `registerProject` call on purpose: the DERIVATION itself must allocate
    // against the stored ids. With registration in the path this passed on the
    // base too, where the write produced the same suffixed id (review m3).
    const foreignId = allocateProjectSlug(projectRoot, []);
    const rows = await listProjects();
    expect(rows.map((row) => row.id)).toEqual([allocateProjectSlug(projectRoot, [foreignId])]);
    expect(rows[0]!.id).not.toBe(foreignId);
  });

  it('keeps addedAt stable across two starts in the mode', async () => {
    const machinePath = join(projectRoot, '.local', 'xezar', 'machine-state.json');
    const first = await registerProject(projectRoot);

    // A second "start" is a fresh module instance: DERIVED_AT is minted at module
    // load, so only a row that reads the persisted stamp keeps the same value.
    // Wait past the first stamp's millisecond so a re-derived fallback is visibly
    // different rather than equal by clock resolution.
    const firstMs = Date.parse(first.addedAt);
    while (Date.now() <= firstMs) await new Promise((resolve) => setTimeout(resolve, 1));

    vi.resetModules();
    const layout = await import('../state-layout.ts');
    layout.setActiveStateLayout(layout.projectStateLayout(projectRoot));
    const fresh = await import('./projects.ts');
    const second = await fresh.registerProject(projectRoot);
    layout.setActiveStateLayout(null);

    expect(second.addedAt).toBe(first.addedAt);
    expect(Date.parse(second.addedAt)).toBe(firstMs);
    // ...and the first start persisted it, so the next start can reuse it.
    expect(JSON.parse(readFileSync(machinePath, 'utf8'))).toMatchObject({ addedAt: first.addedAt });
  });
});

/**
 * `instanceModeInForce` — the six-row cross-product of spec § 2.3 (#467 PR 1): two resolved
 * values against three narrowing states. Proven red against the named break
 * `narrowing-loses` (return the resolved value regardless of `singleProjectNarrowing`).
 */
describe('instanceModeInForce (#467, spec § 2.3–2.4)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(realpathSync(tmpdir()), 'xez-instance-'));
    mkdirSync(join(projectRoot, '.xezar'), { recursive: true });
  });

  afterEach(() => {
    setActiveStateLayout(null);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  describe('no narrowing — the request stands', () => {
    it('workspace resolves to workspace, i.e. today’s behaviour', () => {
      expect(instanceModeInForce({ instance: 'workspace' }, {})).toBe('workspace');
    });

    it('project resolves to project — the opt-in mode', () => {
      expect(instanceModeInForce({ instance: 'project' }, {})).toBe('project');
    });
  });

  describe('AC-1.5 the env-flag narrowing wins over both requests', () => {
    it('named break `narrowing-loses`: an explicit workspace cannot re-widen it', () => {
      // The promise BACKWARD_COMPATIBILITY.md § Single-project workspace mode makes to
      // someone who set the variable on purpose: nothing re-widens it.
      expect(
        instanceModeInForce({ instance: 'workspace' }, { XEZ_SINGLE_PROJECT: '1' }),
      ).toBe('narrowed');
    });

    it('named break `narrowing-loses`: project answers narrowed, not project', () => {
      // `narrowed` is its own word so nothing downstream reads "someone asked for
      // --instance project" out of a cockpit narrowed by a shell variable.
      expect(
        instanceModeInForce({ instance: 'project' }, { XEZ_SINGLE_PROJECT: '1' }),
      ).toBe('narrowed');
    });

    it('only the exact string 1 narrows — the strict activation rule is unchanged', () => {
      expect(instanceModeInForce({ instance: 'project' }, { XEZ_SINGLE_PROJECT: 'true' })).toBe(
        'project',
      );
    });
  });

  describe('AC-1.5 the project-root narrowing wins over both requests', () => {
    it('named break `narrowing-loses`: an explicit workspace cannot re-widen a folder that owns its state', () => {
      setActiveStateLayout(projectStateLayout(projectRoot));
      expect(instanceModeInForce({ instance: 'workspace' }, {})).toBe('narrowed');
    });

    it('named break `narrowing-loses`: project answers narrowed there too', () => {
      setActiveStateLayout(projectStateLayout(projectRoot));
      expect(instanceModeInForce({ instance: 'project' }, {})).toBe('narrowed');
    });
  });
});

/**
 * `instanceBootLine` — the one line a start prints about the instance mode (#467 PR 2, spec
 * § 2.5). The table it implements is § 2.3's, and the property worth pinning is the SILENCE:
 * four of its six rows print nothing, and a change that made any of them print would put a new
 * line into every existing start.
 */
describe('instanceBootLine (#467, spec § 2.5)', () => {
  const line = (over: Parameters<typeof instanceBootLine>[0]) => instanceBootLine(over);

  it('the default workspace mode says nothing — a start that changed nothing prints nothing', () => {
    expect(
      line({
        mode: 'workspace',
        narrowing: null,
        requested: 'workspace',
        explicit: false,
        projectName: 'xezar',
      }),
    ).toBeNull();
  });

  it('an explicit --instance workspace with no narrowing also says nothing', () => {
    // It got exactly what it asked for. A line here would be noise on the default path.
    expect(
      line({
        mode: 'workspace',
        narrowing: null,
        requested: 'workspace',
        explicit: true,
        projectName: 'xezar',
      }),
    ).toBeNull();
  });

  it('project mode says so once, at info, naming the project and the link-out', () => {
    expect(
      line({
        mode: 'project',
        narrowing: null,
        requested: 'project',
        explicit: true,
        projectName: 'xezar',
      }),
    ).toEqual({
      level: 'info',
      message:
        'project mode — this cockpit serves xezar only; other projects are links to their own cockpit',
    });
  });

  it('a narrowing nobody argued with stays silent, under either narrowing', () => {
    for (const narrowing of ['env-flag', 'project-root'] as const) {
      expect(
        line({
          mode: 'narrowed',
          narrowing,
          requested: 'workspace',
          explicit: false,
          projectName: 'xezar',
        }),
      ).toBeNull();
    }
  });

  it('an explicit workspace under XEZ_SINGLE_PROJECT warns once, naming the narrowing', () => {
    expect(
      line({
        mode: 'narrowed',
        narrowing: 'env-flag',
        requested: 'workspace',
        explicit: true,
        projectName: 'xezar',
      }),
    ).toEqual({
      level: 'warn',
      message:
        '--instance workspace is ignored — single-project mode is enabled, so this cockpit already serves one project',
    });
  });

  it('the project-root narrowing says the folder owns its state, never “the flag is enabled”', () => {
    // A folder that carries no flag must not be described as one, for the same reason
    // `singleProjectRefusalText` keeps two sentences.
    expect(
      line({
        mode: 'narrowed',
        narrowing: 'project-root',
        requested: 'workspace',
        explicit: true,
        projectName: 'xezar',
      })?.message,
    ).toBe(
      '--instance workspace is ignored — this folder owns its xezar state, so this cockpit already serves one project',
    );
  });

  it('an explicit project under a narrowing is info, not a warning — it is already satisfied', () => {
    expect(
      line({
        mode: 'narrowed',
        narrowing: 'env-flag',
        requested: 'project',
        explicit: true,
        projectName: 'xezar',
      }),
    ).toEqual({
      level: 'info',
      message:
        '--instance project is already in force — single-project mode is enabled, so this cockpit already serves one project',
    });
  });
});
