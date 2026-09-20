import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bareDirFor, ensureBareClone, fetchAll, skillsCatalogVersions, waitForTeamSkills } from './skills-remote.ts';
import { projectStateLayout, setActiveStateLayout } from './state-layout.ts';

/**
 * The skill-catalog version read (#744): which commit of the team-skills clone this project is
 * serving, which one it last saw upstream, and how that degrades.
 *
 * Real git against real fixture repositories rather than a mocked runner: the whole feature is
 * what `rev-parse`, `log`, `describe` and `merge-base` answer about a bare clone, and a mock of
 * those would be a mock of the thing under test. The cache is pinned into a temp project layout
 * (the single-project cache root, #600 AC-5), so no case can touch `~/.cache/xez`.
 */

const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const GIT_ENV = {
  ...process.env,
  // The fixtures must not inherit the developer's own git config: `tag.gpgSign`,
  // `tag.annotate` and friends turn a plain `git tag` into a signed one and the setup fails on
  // one machine and not another.
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.test',
};

function git(args: string[], cwd: string, date?: string): void {
  execFileSync(REAL_GIT, args, {
    cwd,
    stdio: 'ignore',
    env: date ? { ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : GIT_ENV,
  });
}

/** An origin repository holding one team skill, committed on `main` at a fixed date. */
function makeOrigin(dir: string, body: string, date: string, tag?: string): void {
  mkdirSync(join(dir, 'demo'), { recursive: true });
  git(['init', '-b', 'main'], dir);
  writeFileSync(join(dir, 'demo', 'SKILL.md'), body, 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'fixture'], dir, date);
  if (tag) git(['tag', tag], dir);
}

function commitMore(dir: string, body: string, date: string, tag?: string): void {
  writeFileSync(join(dir, 'demo', 'SKILL.md'), body, 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'second'], dir, date);
  if (tag) git(['tag', tag], dir);
}

describe('skillsCatalogVersions', () => {
  const savedPath = process.env.PATH;
  let project: string;
  let origin: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'xez-catalog-project-'));
    origin = mkdtempSync(join(tmpdir(), 'xez-catalog-origin-'));
    // Pin the cache root into the temp project: `bareDirFor` resolves through the active layout.
    setActiveStateLayout(projectStateLayout(project));
    mkdirSync(join(project, '.xezar'), { recursive: true });
    writeFileSync(
      join(project, '.xezar', 'config.json'),
      JSON.stringify({ skillsRepos: [{ repo: origin, ref: 'main' }] }),
      'utf8',
    );
  });

  afterEach(() => {
    setActiveStateLayout(null);
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(project, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  });

  it('reports the served commit, its tag and its date, and reads up to date (AC-01, AC-03, AC-04)', async () => {
    makeOrigin(origin, '# demo\n', '2026-01-02T10:00:00+01:00', 'v1.2.3');
    await ensureBareClone(origin);
    const [entry] = await skillsCatalogVersions(project);
    expect(entry).toMatchObject({ repo: origin, ref: 'main', state: 'up-to-date' });
    expect(entry?.installed?.tag).toBe('v1.2.3');
    expect(entry?.installed?.date).toBe('2026-01-02');
    expect(entry?.installed?.shortCommit).toHaveLength(7);
    expect(entry?.available).toEqual(entry?.installed);
    expect(entry?.fetchedAt).not.toBeNull();
  });

  it('omits the tag KEY entirely when no tag is reachable (AC-02)', async () => {
    makeOrigin(origin, '# demo\n', '2026-01-02T10:00:00+01:00');
    await ensureBareClone(origin);
    const [entry] = await skillsCatalogVersions(project);
    // Asserted on the OBJECT, not only on its JSON: `tag: undefined` is an own property that
    // `JSON.stringify` silently drops, so a wire-only assertion is green against exactly the
    // `key: maybeUndefined` shape AGENTS.md names as the recurring contract break.
    expect(Object.hasOwn(entry?.installed ?? {}, 'tag')).toBe(false);
    expect(Object.hasOwn(entry?.installed ?? {}, 'shortCommit')).toBe(true);
    const wire = JSON.parse(JSON.stringify(entry)) as { installed: Record<string, unknown> };
    expect(Object.hasOwn(wire.installed, 'tag')).toBe(false);
  });

  it('reads update-available when the clone head moved past the served catalog (AC-04)', async () => {
    makeOrigin(origin, '# demo\n', '2026-01-02T10:00:00+01:00', 'v1.0.0');
    // List the catalog first: that is what "installed" means — the commit being served.
    const listed = await waitForTeamSkills(project);
    expect(listed.map((skill) => skill.name)).toContain('demo');
    commitMore(origin, '# demo v2\n', '2026-03-04T10:00:00+01:00', 'v2.0.0');
    // Advance the clone without re-listing: a fetch landed after the catalog was read.
    await fetchAll(bareDirFor(origin));

    const [entry] = await skillsCatalogVersions(project);
    expect(entry?.state).toBe('update-available');
    expect(entry?.installed?.tag).toBe('v1.0.0');
    expect(entry?.available?.tag).toBe('v2.0.0');
    expect(entry?.installed?.commit).not.toBe(entry?.available?.commit);
  });

  it('answers unknown with no commits on a cold cache, and never throws (AC-05)', async () => {
    makeOrigin(origin, '# demo\n', '2026-01-02T10:00:00+01:00');
    const [entry] = await skillsCatalogVersions(project);
    expect(entry).toEqual({ repo: origin, ref: 'main', state: 'unknown', fetchedAt: null });
    const wire = JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
    expect(Object.hasOwn(wire, 'installed')).toBe(false);
    expect(Object.hasOwn(wire, 'available')).toBe(false);
  });

  it('answers unknown when git itself cannot run (AC-06)', async () => {
    makeOrigin(origin, '# demo\n', '2026-01-02T10:00:00+01:00');
    await ensureBareClone(origin);
    const empty = mkdtempSync(join(tmpdir(), 'xez-catalog-nogit-'));
    process.env.PATH = empty;
    const versions = await skillsCatalogVersions(project);
    expect(versions).toEqual([{ repo: origin, ref: 'main', state: 'unknown', fetchedAt: null }]);
    rmSync(empty, { recursive: true, force: true });
  });

  it('performs no network git — no fetch, no clone, no ls-remote (AC-07)', async () => {
    makeOrigin(origin, '# demo\n', '2026-01-02T10:00:00+01:00', 'v1.2.3');
    await ensureBareClone(origin);
    // A `git` shim earlier on PATH that records every invocation and then runs the real one.
    const bin = mkdtempSync(join(tmpdir(), 'xez-catalog-bin-'));
    const log = join(bin, 'calls.log');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`, 'utf8');
    chmodSync(join(bin, 'git'), 0o755);
    writeFileSync(log, '', 'utf8');
    process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`;

    const [entry] = await skillsCatalogVersions(project);
    expect(entry?.state).toBe('up-to-date');
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((line) => /\b(fetch|clone|ls-remote|push|pull)\b/.test(line))).toEqual([]);
    rmSync(bin, { recursive: true, force: true });
  });

  it('answers an empty list when no skills source is configured', async () => {
    writeFileSync(join(project, '.xezar', 'config.json'), JSON.stringify({ skillsRepos: [] }), 'utf8');
    expect(await skillsCatalogVersions(project)).toEqual([]);
  });
});
