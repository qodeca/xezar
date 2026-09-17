import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveStateLayout, setActiveStateLayout } from '../state-layout.ts';
import { mergeWriteWorkspaceConfig } from './config.ts';
import { mergeWriteWorkspaceUiState } from './ui-state.ts';
import { mergeWriteAgentAccounts } from './agent-accounts.ts';
import { registerProject } from './projects.ts';
import { runMigrations } from './migrations.ts';

/**
 * AC-11 / SP-1.5 — the never-open-`~/.xezar` proof.
 *
 * The premortem failure for single-project mode (#600) is half-isolation: one
 * code path still reaching the real home, so two projects quietly share state.
 * That failure is SILENT, which is why it gets a proof rather than an
 * assertion, and why the proof is built the way `home-safety.test.ts` builds
 * its own: against a home the process genuinely may not write to.
 *
 * The permission is what makes it a proof. A `.xezar` at mode `0500` holding a
 * sentinel file turns "we redirected that path" into "the write would have
 * failed loudly if we had not": a leaked write raises `EACCES` instead of
 * succeeding quietly into a temp directory, and the sentinel's own bytes,
 * size and mtime say whether anything touched what was already there.
 *
 * `VITEST` is deleted from the subprocess case on purpose. Inside this process
 * `assertXezarHomeWriteIsSandboxed` would refuse a leaked write before the
 * filesystem saw it — a useful second net, but it means a green result proves
 * the guard fired rather than that no write was attempted. The subprocess runs
 * without it, so the only thing standing between the boot and the home is the
 * resolved layout.
 */
describe('single-project mode never opens the real xezar home (AC-11)', () => {
  const originalHome = process.env.HOME;
  const originalXezHome = process.env.XEZ_HOME;
  let base: string;
  let fakeHome: string;
  let homeXezar: string;
  let sentinel: string;
  let project: string;

  const SENTINEL_BYTES = '{"projects":[{"id":"the-users-own","root":"/repos/theirs"}]}\n';

  beforeEach(() => {
    base = mkdtempSync(join(realpathSync(tmpdir()), 'xez-sp-home-'));
    fakeHome = join(base, 'home');
    homeXezar = join(fakeHome, '.xezar');
    sentinel = join(homeXezar, 'config.json');
    project = join(base, 'project');
    mkdirSync(homeXezar, { recursive: true });
    writeFileSync(sentinel, SENTINEL_BYTES, 'utf8');
    mkdirSync(project, { recursive: true });
    // Read and traverse, never write. Applied AFTER the sentinel exists,
    // because the point is a home that already holds the user's own setup.
    chmodSync(homeXezar, 0o500);
    process.env.HOME = fakeHome;
    delete process.env.XEZ_HOME;
  });

  afterEach(() => {
    setActiveStateLayout(null);
    chmodSync(homeXezar, 0o700);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXezHome === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = originalXezHome;
    rmSync(base, { recursive: true, force: true });
  });

  /** Content, size and mtime — the three ways a write shows up. */
  const sentinelState = (): { bytes: string; size: number; mtimeMs: number } => {
    const stat = statSync(sentinel);
    return { bytes: readFileSync(sentinel, 'utf8'), size: stat.size, mtimeMs: stat.mtimeMs };
  };

  it('writes settings, GUI state and accounts into the project, leaving the home untouched', async () => {
    const before = sentinelState();
    setActiveStateLayout(resolveStateLayout(project, ['--single-project'], process.env));

    // The boot's own workspace bookkeeping, then one write per state file.
    await runMigrations({ bootRepoRoot: project });
    await registerProject(project);
    await mergeWriteWorkspaceConfig((config) => {
      config.resources.maxParallel = 7;
    });
    await mergeWriteWorkspaceUiState((state) => {
      state.appearance = { theme: 'dark' };
    });
    await mergeWriteAgentAccounts((store) => {
      store.defaults = { claude: 'second-login' };
    });

    // Everything landed in the project...
    const stateDir = join(project, '.xezar');
    expect(JSON.parse(readFileSync(join(stateDir, 'workspace.json'), 'utf8'))).toMatchObject({
      resources: { maxParallel: 7 },
      projects: [{ root: realpathSync(project) }],
    });
    expect(JSON.parse(readFileSync(join(stateDir, 'workspace-ui.json'), 'utf8'))).toMatchObject({
      appearance: { theme: 'dark' },
    });
    expect(JSON.parse(readFileSync(join(stateDir, 'agent-accounts.json'), 'utf8'))).toMatchObject({
      defaults: { claude: 'second-login' },
    });

    // ...and the home holds exactly what it held before, byte for byte.
    expect(sentinelState()).toEqual(before);
    expect(readdirSync(homeXezar)).toEqual(['config.json']);
  });

  it('does not create a home at all when the user has none', async () => {
    chmodSync(homeXezar, 0o700); // so this case can remove it at all
    rmSync(homeXezar, { recursive: true, force: true });
    chmodSync(fakeHome, 0o500);
    setActiveStateLayout(resolveStateLayout(project, ['--single-project'], process.env));

    await runMigrations({ bootRepoRoot: project });
    await mergeWriteWorkspaceConfig((config) => {
      config.resources.maxParallel = 3;
    });

    expect(readdirSync(fakeHome)).toEqual([]);
    chmodSync(fakeHome, 0o700);
    mkdirSync(homeXezar, { recursive: true }); // so afterEach's chmod has a target
  });

  it('still uses the home in the GLOBAL layout — the isolation is the mode, not the code', async () => {
    // The mirror case, and the one that would catch an over-eager redirect: a
    // plain `xez` must keep writing where it always has. The read-only home
    // makes that visible as a thrown write rather than as a silent success.
    setActiveStateLayout(null);

    await expect(
      mergeWriteWorkspaceConfig((config) => {
        config.resources.maxParallel = 5;
      }),
    ).rejects.toThrow();
    expect(readdirSync(join(project)).length).toBe(0);
  });

  it('boots the real CLI against a read-only home without touching it (subprocess, no VITEST guard)', () => {
    const before = sentinelState();
    const cliEntry = fileURLToPath(new URL('../index.ts', import.meta.url));
    const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome };
    delete env.XEZ_HOME;
    // Without this the in-process write guard would refuse a leaked write
    // before the filesystem could, and a green run would prove the guard
    // rather than the redirection.
    delete env.VITEST;

    // `node --import tsx`, not the `tsx` binary: that binary re-executes node
    // through a unix-socket IPC channel under `TMPDIR`, and the nested temp
    // directory a xezar task run inherits exceeds the ~104-byte socket-path
    // limit (EINVAL). The loader form runs the CLI in THIS process's child and
    // needs no socket.
    const runCli = (...args: string[]): ReturnType<typeof spawnSync> =>
      spawnSync(process.execPath, ['--import', 'tsx', cliEntry, ...args], { cwd: project, env, encoding: 'utf8' });

    // `projects` opens no port, so it is the cheapest command that boots the
    // layout for real — and `add` makes it WRITE the registry, which is the
    // half of the proof a read-only home can actually refuse.
    const run = runCli('projects', 'list', '--single-project');
    const added = runCli('projects', 'add', project);

    expect(run.status, run.stderr).toBe(0);
    expect(added.status, added.stderr).toBe(0);
    // The registry landed in the project. Without this the case is also
    // satisfied by a boot that TRIED the read-only home, failed and degraded
    // quietly — which is the leak, not the fix.
    expect(JSON.parse(readFileSync(join(project, '.xezar', 'workspace.json'), 'utf8'))).toMatchObject({
      projects: [{ root: realpathSync(project) }],
    });
    // FR-9.1: exactly one line names the mode and the state folder.
    const modeLines = run.stdout.split('\n').filter((line) => line.includes('single-project mode'));
    expect(modeLines).toHaveLength(1);
    expect(modeLines[0]).toContain(join(project, '.xezar'));

    // AC-2: the four files, in the project. The fifth entry is
    // `workspace.json.bak` — the registry snapshot every successful
    // merge-write has always refreshed beside `config.json`, now beside the
    // file it protects. It is derived state, not a fifth state file: the
    // first-run listing is exactly four (see `createProjectStateFiles` in
    // `state-layout.test.ts`), and this case has just written a registry.
    expect(readdirSync(join(project, '.xezar')).sort()).toEqual([
      'agent-accounts.json',
      'config.json',
      'workspace-ui.json',
      'workspace.json',
      'workspace.json.bak',
    ]);
    // Nothing the commands printed even NAMES the home.
    expect(run.stdout + run.stderr).not.toContain(homeXezar);
    expect(added.stdout + added.stderr).not.toContain(homeXezar);
    // AC-11: the home is as it was, and gained nothing.
    expect(sentinelState()).toEqual(before);
    expect(readdirSync(homeXezar)).toEqual(['config.json']);
  }, 60_000);
});
