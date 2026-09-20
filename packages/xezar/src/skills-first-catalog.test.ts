import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverSkills,
  lookupRunSkill,
  skillMissingNote,
  FIRST_TEAM_CATALOG_WAIT_MS,
} from './skills.ts';
import { projectStateLayout, setActiveStateLayout } from './state-layout.ts';

/**
 * #777 — a brand-new project's FIRST task resolved the skill it was asked for against a team
 * catalog whose first fetch had not landed yet, so a task asking for a team skill silently ran
 * the plain prompt while the fetch succeeded moments later.
 *
 * Real git against a real fixture origin, with a `git` shim on PATH that makes the first CLONE
 * take a measurable moment — that delay is the bug's whole shape, and a mock of it would be a
 * mock of the thing under test. The cache is pinned into a temp single-project layout (#600
 * AC-5), so no case touches `~/.cache/xez`, and `XEZ_HOME` stays pinned by `vitest.setup.ts`.
 *
 * BREAK-777-NO-WAIT: resolve the run's skill with a plain `skills.find(...)` against the first
 * `discoverSkills` list — the pre-fix code — and the first case below goes red while the
 * fall-through cases stay green, which is exactly what made the bug invisible.
 */

const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.test',
};

/** An origin repository holding one directory-convention team skill on `main`. */
function makeOrigin(dir: string, name: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\n---\n\nthe team body\n`, 'utf8');
  for (const args of [['init', '-b', 'main'], ['add', '-A'], ['commit', '-m', 'fixture']]) {
    execFileSync(REAL_GIT, args, { cwd: dir, stdio: 'ignore', env: GIT_ENV });
  }
}

/** A `git` on PATH that sleeps before a CLONE and then runs the real one. */
function installSlowCloneGit(bin: string, seconds: string): void {
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "clone" ]; then sleep ${seconds}; break; fi\ndone\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`,
    'utf8',
  );
  chmodSync(join(bin, 'git'), 0o755);
}

describe("a run's first skill resolution and the first team-skills fetch (#777)", () => {
  const savedPath = process.env.PATH;
  let project: string;
  let origin: string;
  let bin: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'xez-777-project-'));
    origin = mkdtempSync(join(tmpdir(), 'xez-777-origin-'));
    bin = mkdtempSync(join(tmpdir(), 'xez-777-bin-'));
    // The cache root moves into the temp project, so the fixture clone can never land in the
    // developer's own `~/.cache/xez`.
    setActiveStateLayout(projectStateLayout(project));
    mkdirSync(join(project, '.xezar'), { recursive: true });
  });

  afterEach(() => {
    setActiveStateLayout(null);
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    for (const dir of [project, origin, bin]) rmSync(dir, { recursive: true, force: true });
  });

  function configure(sources: Array<{ repo: string; ref: string }>): void {
    writeFileSync(
      join(project, '.xezar', 'config.json'),
      JSON.stringify({ skillsRepos: sources }),
      'utf8',
    );
  }

  it('waits, bounded, for the first fetch and then resolves the team skill', async () => {
    makeOrigin(origin, 'xez-demo');
    configure([{ repo: origin, ref: 'main' }]);
    installSlowCloneGit(bin, '1');
    process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`;

    // The precondition, i.e. the bug: the catalog read returns before the fetch it started.
    const first = await discoverSkills(project);
    expect(first.find((skill) => skill.name === 'xez-demo')).toBeUndefined();

    const lookup = await lookupRunSkill(project, 'xez-demo', first, FIRST_TEAM_CATALOG_WAIT_MS);
    expect(lookup.catalog).toBe('ready');
    expect(lookup.skill?.source).toBe('team');
    expect(lookup.skill?.body).toContain('the team body');
    // The refreshed catalog is what the caller keeps, so `/skill` expansion sees it too.
    expect(lookup.skills.map((skill) => skill.name)).toContain('xez-demo');
  });

  it('falls through when the first fetch outlasts the bound, and says the catalog was not ready', async () => {
    makeOrigin(origin, 'xez-demo');
    configure([{ repo: origin, ref: 'main' }]);
    installSlowCloneGit(bin, '5');
    process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`;

    const first = await discoverSkills(project);
    const startedAt = Date.now();
    const lookup = await lookupRunSkill(project, 'xez-demo', first, 100);
    // Bounded: the step starts anyway rather than waiting out the fetch.
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(lookup.skill).toBeUndefined();
    expect(lookup.catalog).toBe('pending');

    const note = skillMissingNote('xez-demo', lookup.catalog);
    expect(note).toContain('not ready');
    expect(note).toContain('Retry');
    // The whole point: no longer the sentence that means "this skill does not exist anywhere".
    expect(note).not.toBe(skillMissingNote('xez-demo', 'ready'));
  });

  it('reports an unreadable source as unavailable, not as a missing skill', async () => {
    configure([{ repo: join(origin, 'no-such-repo'), ref: 'main' }]);

    const first = await discoverSkills(project);
    const lookup = await lookupRunSkill(project, 'xez-demo', first, FIRST_TEAM_CATALOG_WAIT_MS);
    expect(lookup.skill).toBeUndefined();
    expect(lookup.catalog).toBe('unavailable');
    expect(skillMissingNote('xez-demo', lookup.catalog)).toContain('no access');
  });

  /* Guards below pass both ways — they pin what must NOT change. */

  it('never waits when the project configures no skills source at all', async () => {
    configure([]);
    const first = await discoverSkills(project);
    const startedAt = Date.now();
    const lookup = await lookupRunSkill(project, 'xez-demo', first, FIRST_TEAM_CATALOG_WAIT_MS);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(lookup.catalog).toBe('ready');
    expect(lookup.skill).toBeUndefined();
    // Nothing was fetched and nothing could be: the historical sentence is the true one here.
    expect(skillMissingNote('xez-demo', lookup.catalog)).toBe(
      'skill "xez-demo" not found in .xezar/skills, .ai/skills or the team skills repo — running with the plain prompt',
    );
  });

  it('never waits when the skill is already in the local catalog', async () => {
    makeOrigin(origin, 'xez-demo');
    configure([{ repo: origin, ref: 'main' }]);
    installSlowCloneGit(bin, '5');
    process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`;
    mkdirSync(join(project, '.xezar', 'skills'), { recursive: true });
    writeFileSync(join(project, '.xezar', 'skills', 'local-one.md'), '# local\n', 'utf8');

    const first = await discoverSkills(project);
    const startedAt = Date.now();
    const lookup = await lookupRunSkill(project, 'local-one', first, FIRST_TEAM_CATALOG_WAIT_MS);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(lookup.skill?.source).toBe('xezar');
  });

  it('does not wait at all when the caller passes a zero bound (the dry-run path)', async () => {
    makeOrigin(origin, 'xez-demo');
    configure([{ repo: origin, ref: 'main' }]);
    installSlowCloneGit(bin, '5');
    process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`;

    const first = await discoverSkills(project);
    const startedAt = Date.now();
    const lookup = await lookupRunSkill(project, 'xez-demo', first, 0);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(lookup.catalog).toBe('pending');
    expect(lookup.skill).toBeUndefined();
  });
});
