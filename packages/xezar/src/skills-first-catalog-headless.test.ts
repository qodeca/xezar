import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * #793 — the bounded first-team-skills wait #791 added parked a headless `xezar run` on a timer
 * that was `unref`'d, while the other side of the race (the `git clone` child and its three
 * pipes) has been unref'd since #249. `runAgentStep` has not spawned the agent yet at that
 * point, so the run held NO ref'd handle: node's loop emptied and the process exited 0 mid-step,
 * with no skill note, no step end and the persisted run record left at `running` forever.
 *
 * This has to run OUT OF PROCESS. Inside vitest the worker itself keeps the loop alive, so every
 * in-process case in `skills-first-catalog.test.ts` passes both ways — the defect is a property
 * of a process whose only pending work is this wait, and nothing short of a real one-shot CLI
 * has that property. So this spawns the real CLI entry on a real fixture project, with a `git`
 * shim that makes the first clone take a real second (the reported shape: any cold clone does).
 *
 * BREAK-793-UNREF: restore `timer.unref?.()` in `awaitFirstTeamSkills` (`skills-remote.ts`) and
 * this case goes red — the CLI exits 0 with its output ending at the step banner.
 */

const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.test',
};

// `node --import <loader>`, not the `tsx` binary: that binary re-executes node over a unix
// socket under `TMPDIR`, and a task worktree's nested temp path exceeds the ~104-byte socket
// limit. Resolved here to an absolute URL because `--import` resolves a bare specifier from the
// CHILD's cwd, which is a scratch project with no `node_modules` above it (same trap as
// `workspace/single-project-home-safety.test.ts`).
const tsxLoader = import.meta.resolve('tsx');
const cliEntry = fileURLToPath(new URL('./index.ts', import.meta.url));
const mockClaude = fileURLToPath(new URL('../scripts/mock-claude.mjs', import.meta.url));

function gitInit(dir: string): void {
  for (const args of [['init', '-b', 'main'], ['add', '-A'], ['commit', '-m', 'fixture']]) {
    execFileSync(REAL_GIT, args, { cwd: dir, stdio: 'ignore', env: { ...process.env, ...GIT_ENV } });
  }
}

describe('a headless run survives its own first-team-skills wait (#793)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xez-793-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves the team skill and finishes the run when the first clone takes a second', () => {
    const origin = join(root, 'origin');
    const project = join(root, 'project');
    const bin = join(root, 'bin');
    const home = join(root, 'home');

    // The team-skills source: one directory-convention skill the project cannot resolve locally.
    mkdirSync(join(origin, 'xez793-onboard'), { recursive: true });
    writeFileSync(
      join(origin, 'xez793-onboard', 'SKILL.md'),
      '---\nname: xez793-onboard\n---\n\nthe team body\n',
      'utf8',
    );
    gitInit(origin);

    // A single-project repo whose only workflow step NAMES that skill.
    mkdirSync(join(project, '.xezar', 'workflows'), { recursive: true });
    writeFileSync(
      join(project, '.xezar', 'workflows', 'one-skill-step.yaml'),
      'name: one-skill-step\nsteps:\n  - id: work\n    skill: xez793-onboard\n    prompt: "{{task}}"\n',
      'utf8',
    );
    writeFileSync(
      join(project, '.xezar', 'config.json'),
      JSON.stringify({ skillsRepos: [{ repo: origin, ref: 'main' }] }),
      'utf8',
    );
    writeFileSync(join(project, 'README.md'), 'fixture\n', 'utf8');
    gitInit(project);

    // The delay is the bug's whole shape and a mock of it would mock the thing under test.
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "clone" ]; then sleep 1; break; fi\ndone\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`,
      'utf8',
    );
    chmodSync(join(bin, 'git'), 0o755);
    mkdirSync(home, { recursive: true });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...GIT_ENV,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      // Both pinned at the fixture: single-project mode never opens `~/.xezar`, and the child
      // must not reach the developer's real home for either half.
      HOME: home,
      XEZ_HOME: home,
      // A real run, deliberately: `XEZ_DRY_RUN=1` passes a ZERO bound and never reaches the wait
      // this case exists for. The backend is mocked at the binary instead, so no token is spent.
      XEZ_CLAUDE_BIN: mockClaude,
      XEZ_AGENT_MODELS_LOCKED: '1',
    };
    delete env.VITEST;
    delete env.XEZ_DRY_RUN;

    // `mock:done` makes the mocked turn end with the XEZ:DONE marker, so the last step completes
    // instead of parking at `waiting` for an answer.
    const run = spawnSync(
      process.execPath,
      [
        '--import',
        tsxLoader,
        cliEntry,
        'run',
        'exercise the first-skill wait mock:done',
        '--workflow',
        'one-skill-step',
        '--repo',
        project,
        '--single-project',
        '--no-open',
        '--output',
        'lines',
      ],
      { cwd: project, env, encoding: 'utf8' },
    );

    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    // The step must have RESOLVED the team skill — the #777 fix working as designed.
    expect(out, out).toContain('xez793-onboard');
    // And the process must have survived the wait to say so. Pre-fix, the output stops at the
    // step banner: exit 0, nothing after it, and the assertion above is what goes red first.
    expect(out, out).toContain('run finished');
    expect(run.status, out).toBe(0);

    // The persisted record is the other half of the failure: an exit mid-`await` leaves the run
    // at `running` with no step end, which is an orphan no later command can finish.
    const index = JSON.parse(
      readFileSync(join(project, '.local', 'xezar', 'runs.json'), 'utf8'),
    ) as { runs?: Array<{ status: string }> } | Array<{ status: string }>;
    const runs = Array.isArray(index) ? index : (index.runs ?? []);
    expect(runs.map((record) => record.status)).toEqual(['done']);
  }, 120_000);
});
