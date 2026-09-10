import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { importableSkillSchema, skillSchema } from '@qodeca/xezar-contract';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SKILLS_REPOS } from '../config.ts';
import { RunStore } from '../runs/store.ts';
import { bareDirFor } from '../skills-remote.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * The skills catalog family — `GET /skills`, `GET /skills/importable`,
 * `POST /skills/refresh` (#51, gap R12 of `docs/testing/coverage-gaps.md`).
 * `route-parity.test.ts` proves the three routes are registered and answer
 * identically under every URL spelling; it asserts nothing about their CONTENT.
 *
 * Two behaviours are load-bearing here and neither had a test:
 *
 *  - The local-first discovery precedence `AGENTS.md` pins and
 *    `BACKWARD_COMPATIBILITY.md` §"skills" protects: `.xezar/skills` →
 *    `.ai/skills` → `.agents/skills` + agent mirrors → global → team repo, with
 *    "the user's repo is the source of truth" on a name collision. Asserted by
 *    BODY, not by name — a name-only assertion passes with the winner inverted.
 *  - `POST /skills/refresh`, which is the one route that goes out to the team
 *    skills repos, and which `AGENTS.md` requires to degrade rather than hang.
 *
 * NOTHING here touches the network. The "remote" is a real git repository in a
 * temp dir, bare-cloned into the module's own cache location, and the cache is
 * relocated by pinning `HOME` — see `fixedHome` below.
 */

/**
 * `~/.cache/xez/skills/…` is where `skills-remote.ts` keeps its bare clones, and
 * `skills.ts` reads `~/.agents/skills` + `~/.claude/skills` for global skills.
 * Both resolve through `os.homedir()`, and `skills.ts` resolves ITS pair once, at
 * module load — so the pin has to happen before the imports above are evaluated.
 * That is exactly what `vi.hoisted` is for. `XEZ_HOME` (pinned per worker by
 * `vitest.setup.ts`) does not cover either path.
 */
const fixedHome = vi.hoisted(() => {
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const base = (process.env.TMPDIR || process.env.TEMP || '/tmp').replace(/[\\/]+$/, '');
  const home = `${base}/xez-skills-api-home-${process.pid}`;
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

/** A fixed identity, so every fixture commit works on a bare CI machine. */
const GIT_ID = ['-c', 'user.email=t@test', '-c', 'user.name=t'];

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function writeSkill(root: string, relPath: string, name: string, body: string): void {
  const path = join(root, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\nname: ${name}\ndescription: ${name} from ${relPath}\n---\n${body}\n`, 'utf8');
}

/** macOS hands out `/var/folders/…`, a symlink; git always answers resolved. */
function scratch(prefix: string): string {
  return mkdtempSync(join(realpathSync(tmpdir()), prefix));
}

/**
 * The stand-in for the vendor skills repo: a real git repository on disk. The
 * bare clone below lands at exactly the path `bareDirFor` computes for the
 * DEFAULT source, so `skills-remote.ts` finds it without one byte of network —
 * and `git fetch origin` on a refresh pulls from this local directory.
 */
function makeTeamRepo(): { source: string; bareDir: string } {
  const source = scratch('xez-skills-source-');
  git(source, 'init', '-q', '-b', DEFAULT_SKILLS_REPOS[0]!.ref);
  writeSkill(source, '.xezar/skills/shared.md', 'shared', 'TEAM BODY for shared');
  writeSkill(source, '.xezar/skills/team-only.md', 'team-only', 'TEAM BODY for team-only');
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', 'skills');

  const bareDir = bareDirFor(DEFAULT_SKILLS_REPOS[0]!.repo);
  mkdirSync(dirname(bareDir), { recursive: true });
  execFileSync('git', [...GIT_ID, 'clone', '-q', '--bare', '--', source, bareDir], { stdio: 'pipe' });
  return { source, bareDir };
}

/** Commit one more skill to the team repo — only a refresh should surface it. */
function addTeamSkill(source: string, name: string, body: string): void {
  writeSkill(source, `.xezar/skills/${name}.md`, name, body);
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', `add ${name}`);
}

async function readSkills(app: Hono, path: string) {
  const response = await apiRequest(app, path);
  expect(response.status).toBe(200);
  return skillSchema.array().parse(await response.json());
}

describe('the skills catalog API', () => {
  let repoRoot: string;
  let source: string;
  let bareDir: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    mkdirSync(fixedHome.home, { recursive: true });
    ({ source, bareDir } = makeTeamRepo());

    repoRoot = scratch('xez-skills-api-repo-');
    mkdirSync(join(repoRoot, '.local/xezar'), { recursive: true });
    // Deliberately NO `.xezar/config.json`: the zero-config majority, where the
    // default vendor repo is in effect and is the gated (importable) set.
    writeSkill(repoRoot, '.xezar/skills/shared.md', 'shared', 'LOCAL XEZAR BODY for shared');
    writeSkill(repoRoot, '.xezar/skills/order.md', 'order', 'XEZAR BODY');
    writeSkill(repoRoot, '.ai/skills/order.md', 'order', 'AI BODY');
    writeSkill(repoRoot, '.ai/skills/ai-only.md', 'ai-only', 'AI BODY for ai-only');
    writeSkill(repoRoot, '.agents/skills/order/SKILL.md', 'order', 'AGENTS BODY');
    writeSkill(fixedHome.home, '.claude/skills/order/SKILL.md', 'order', 'GLOBAL BODY');

    store = RunStore.open(join(repoRoot, '.local/xezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    for (const dir of [repoRoot, source, bareDir, join(fixedHome.home, '.claude')]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The precedence assertion of #51. Every layer contributes a skill called
   * `order`, and a local `shared` collides with a team `shared`; the winners are
   * checked by BODY, so inverting the discovery order in `skills.ts` — either
   * `SKILL_DIRS` or the `[...lists, teamSkills]` merge — turns this red.
   */
  it('serves the merged catalog local-first, with the repo as the source of truth', async () => {
    const skills = await readSkills(app, '/api/v1/skills?wait=1');

    const shared = skills.filter((skill) => skill.name === 'shared');
    expect(shared).toHaveLength(1);
    expect(shared[0]?.source).toBe('xezar');
    expect(shared[0]?.body.trim()).toBe('LOCAL XEZAR BODY for shared');
    expect(shared[0]?.body).not.toContain('TEAM BODY');
    expect(shared[0]?.team).toBeUndefined();

    // The collision above is only meaningful if the team catalog really loaded.
    const teamOnly = skills.find((skill) => skill.name === 'team-only');
    expect(teamOnly?.source).toBe('team');
    expect(teamOnly?.body.trim()).toBe('TEAM BODY for team-only');
    expect(teamOnly?.team?.repo).toBe(DEFAULT_SKILLS_REPOS[0]!.repo);

    // `.xezar` beats `.ai` beats `.agents` beats the global mirror.
    const order = skills.filter((skill) => skill.name === 'order');
    expect(order).toHaveLength(1);
    expect(order[0]?.source).toBe('xezar');
    expect(order[0]?.body.trim()).toBe('XEZAR BODY');

    // Sorted by name, and every layer that did not collide still shows up.
    expect(skills.map((skill) => skill.name)).toEqual([...skills.map((s) => s.name)].sort());
    expect(skills.map((skill) => skill.name)).toContain('ai-only');
  });

  it('offers the vendor repo catalog as importable and never a local-only skill', async () => {
    const response = await apiRequest(app, '/api/v1/skills/importable?wait=1');
    expect(response.status).toBe(200);
    const names = importableSkillSchema
      .array()
      .parse(await response.json())
      .map((skill) => skill.name);

    expect(names).toContain('team-only');
    // Local skills are not part of the importable set at all.
    expect(names).not.toContain('ai-only');
    // Pinning what the route DOES, not what it ideally would: `shared` exists
    // locally AND in the vendor repo, and the panel still offers it — the route
    // lists everything the repo offers so each row can carry its own toggle.
    expect(names).toContain('shared');
  });

  it('refreshes the team repos and returns the freshly merged catalog', async () => {
    const before = await readSkills(app, '/api/v1/skills?wait=1');
    expect(before.map((skill) => skill.name)).not.toContain('late-skill');
    addTeamSkill(source, 'late-skill', 'TEAM BODY for late-skill');

    const response = await apiRequest(app, '/api/v1/skills/refresh', { method: 'POST' });
    expect(response.status).toBe(200);
    const refreshed = skillSchema.array().parse(await response.json());

    // What it refreshed: the new team skill, read at a resolved commit.
    const late = refreshed.find((skill) => skill.name === 'late-skill');
    expect(late?.source).toBe('team');
    expect(late?.body.trim()).toBe('TEAM BODY for late-skill');
    expect(late?.team?.commit).toMatch(/^[0-9a-f]{40,64}$/);
    // …and the local half of the catalog, precedence intact.
    expect(refreshed.find((skill) => skill.name === 'shared')?.body.trim()).toBe(
      'LOCAL XEZAR BODY for shared',
    );

    // The refreshed list is what the next plain read serves.
    expect((await readSkills(app, '/api/v1/skills')).map((skill) => skill.name)).toContain(
      'late-skill',
    );
  });

  it('keeps refresh behind the origin/CSRF guard', async () => {
    await readSkills(app, '/api/v1/skills?wait=1');
    addTeamSkill(source, 'late-skill', 'TEAM BODY for late-skill');

    const blocked = await app.request('/api/v1/skills/refresh', {
      method: 'POST',
      headers: { host: '127.0.0.1:4321', origin: 'https://evil.test' },
    });
    expect(blocked.status).toBe(403);

    // The guard ran BEFORE the handler: no fetch happened, so the catalog is
    // still the pre-commit one. The same request from the cockpit's own origin
    // does surface it — which is what makes the 403 above a refusal, not a no-op.
    expect((await readSkills(app, '/api/v1/skills?wait=1')).map((s) => s.name)).not.toContain(
      'late-skill',
    );
    const allowed = await apiRequest(app, '/api/v1/skills/refresh', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:4321' },
    });
    expect(allowed.status).toBe(200);
    expect(skillSchema.array().parse(await allowed.json()).map((s) => s.name)).toContain(
      'late-skill',
    );
  });
});

describe('the skills catalog API with an unreachable team repo', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    mkdirSync(fixedHome.home, { recursive: true });
    repoRoot = scratch('xez-skills-api-offline-');
    mkdirSync(join(repoRoot, '.local/xezar'), { recursive: true });
    mkdirSync(join(repoRoot, '.xezar'), { recursive: true });
    // A configured source that cannot be cloned — the offline / no-access shape,
    // without a network call. Configuring `skillsRepos` also un-gates the repo,
    // which is what makes the importable set empty below.
    writeFileSync(
      join(repoRoot, '.xezar/config.json'),
      `${JSON.stringify({ skillsRepos: [{ repo: join(repoRoot, 'no-such-repo'), ref: 'main' }] })}\n`,
      'utf8',
    );
    writeSkill(repoRoot, '.xezar/skills/local-only.md', 'local-only', 'LOCAL BODY');

    store = RunStore.open(join(repoRoot, '.local/xezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** The default 5s test timeout is part of the assertion: a hang fails here. */
  it('answers a refresh it cannot complete, and keeps serving the catalog', async () => {
    const response = await apiRequest(app, '/api/v1/skills/refresh', { method: 'POST' });
    expect(response.status).toBe(200);
    const skills = skillSchema.array().parse(await response.json());
    // Degraded, not failed: local skills keep working, team entries stay absent.
    expect(skills.map((skill) => skill.name)).toEqual(['local-only']);
    expect(skills.every((skill) => skill.source !== 'team')).toBe(true);

    // Still answering afterwards — a failed refresh poisons nothing.
    expect((await readSkills(app, '/api/v1/skills?wait=1')).map((s) => s.name)).toEqual([
      'local-only',
    ]);
    const importable = await apiRequest(app, '/api/v1/skills/importable?wait=1');
    expect(importable.status).toBe(200);
    // A repo that configures its own sources gates nothing — the panel is empty.
    expect(await importable.json()).toEqual([]);
  });
});
