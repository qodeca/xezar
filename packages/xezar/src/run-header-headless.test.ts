import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onWindows, TEST_DIR_RM_OPTIONS } from '../test/helpers/platform.ts';

/**
 * #910 — a headless `xezar run` printed `run started — workflow "live-codex" (runner: claude)` for a
 * one-step workflow whose step set `runner: codex`, and Codex ran it. The header now names the
 * runner each step really uses.
 *
 * Out of process, through the real CLI entry, because the acceptance is about what a headless run
 * PRINTS. The header is written before any agent starts, so the Codex binary is pointed at a path
 * that does not exist: the step then fails at once, no token is spent and nothing on the machine is
 * reached, and the header line has already been printed.
 */

// `node --import <loader>` with an absolute loader URL, for the reasons
// `skills-first-catalog-headless.test.ts` gives (socket path length, child cwd resolution).
const tsxLoader = import.meta.resolve('tsx');
const cliEntry = fileURLToPath(new URL('./index.ts', import.meta.url));

describe('the headless run header names the step’s runner (#910)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xez-910-'));
  });

  afterEach(() => {
    rmSync(root, TEST_DIR_RM_OPTIONS);
  });

  it('prints codex for a one-step workflow with `runner: codex` on the step', () => {
    const project = join(root, 'project');
    const home = join(root, 'home');
    mkdirSync(join(project, '.xezar', 'workflows'), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(project, '.xezar', 'workflows', 'live-codex.yaml'),
      'name: live-codex\nsteps:\n  - id: work\n    runner: codex\n    prompt: "{{task}}"\n',
      'utf8',
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      ...(onWindows ? { USERPROFILE: home } : {}),
      XEZ_HOME: home,
      // No real Codex: a missing binary fails the step after the header is printed.
      XEZ_CODEX_BIN: join(root, 'no-such-codex'),
      // Skips the provider sign-in preflight, which would otherwise refuse before the run starts.
      XEZ_AGENT_MODELS_LOCKED: '1',
    };
    delete env.VITEST;
    delete env.XEZ_DRY_RUN;

    const result = spawnSync(
      process.execPath,
      [
        '--import', tsxLoader, cliEntry, 'run', 'say hello',
        '--workflow', 'live-codex',
        '--repo', project,
        '--single-project',
        '--no-open',
        '--output', 'lines',
      ],
      { cwd: project, env, encoding: 'utf8', timeout: 90_000 },
    );

    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(out, out).toContain('run started — workflow "live-codex" (runner: codex)');
  }, 120_000);
});
