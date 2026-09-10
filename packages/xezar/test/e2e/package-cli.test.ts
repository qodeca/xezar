import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * Every file in a tree keyed by its relative path, so two states of the same
 * directory can be compared byte-for-byte. `.git` is skipped: git rewrites its
 * own bookkeeping for reasons that have nothing to do with the command run.
 */
async function snapshotTree(dir: string, prefix = ''): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(snapshot, await snapshotTree(absolute, relative));
    else snapshot[relative] = await readFile(absolute, 'utf8');
  }
  return snapshot;
}

test('the release tarball installs and runs the dry-run CLI workflow', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xezar-package-e2e-'));

  try {
    const packDir = join(root, 'pack');
    await mkdir(packDir);
    const packed = await execFile(
      npm,
      ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir],
      { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
    );
    const records = JSON.parse(packed.stdout) as Array<{
      filename: string;
      files: Array<{ path: string }>;
    }>;
    const record = records[0];
    assert.ok(record, 'npm pack should describe the generated tarball');

    const packagedPaths = new Set(record.files.map((file) => file.path));
    for (const requiredPath of ['dist/index.js', 'web/dist/index.html', 'scripts/mock-claude.mjs', 'README.md']) {
      assert.ok(packagedPaths.has(requiredPath), `release tarball should contain ${requiredPath}`);
    }
    assert.equal(packagedPaths.has('src/index.ts'), false, 'release tarball should not contain TypeScript sources');
    assert.equal(packagedPaths.has('test/e2e/package-cli.test.ts'), false, 'release tarball should not contain tests');

    const consumerDir = join(root, 'consumer');
    await mkdir(consumerDir);
    await writeFile(join(consumerDir, 'package.json'), '{"private":true}\n', 'utf8');
    const tarball = join(packDir, record.filename);
    await execFile(
      npm,
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball],
      { cwd: consumerDir, maxBuffer: 10 * 1024 * 1024 },
    );

    const packageRoot = join(consumerDir, 'node_modules', '@qodeca', 'xezar');
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      bin: { xezar: string; xez: string };
    };
    assert.equal(manifest.bin.xezar, 'dist/index.js');
    assert.equal(manifest.bin.xez, 'dist/index.js');
    // Exactly two: the unscoped `cezar-cli` distribution is gone, so a third bin here would
    // put a command on a consumer's PATH that nothing publishes.
    assert.deepEqual(Object.keys(manifest.bin).sort(), ['xez', 'xezar']);
    const cliPath = join(packageRoot, manifest.bin.xezar);

    const help = await execFile(process.execPath, [cliPath, '--help'], {
      cwd: consumerDir,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.match(help.stdout, /xezar — local cockpit/);
    assert.match(help.stdout, /xezar run "<task>"/);

    const fixtureRepo = join(root, 'fixture-repo');
    await mkdir(fixtureRepo);
    await execFile('git', ['init', '--initial-branch=main'], { cwd: fixtureRepo });
    await writeFile(join(fixtureRepo, 'README.md'), '# E2E fixture\n', 'utf8');
    await execFile('git', ['add', 'README.md'], { cwd: fixtureRepo });
    await execFile(
      'git',
      ['-c', 'user.name=Xezar CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'test fixture'],
      { cwd: fixtureRepo },
    );

    // XEZ_HOME pins every workspace write (migrations, project registry,
    // server.json) to a temp dir — booting the real CLI must never touch the
    // developer's real ~/.xezar.
    const xezHome = join(root, 'xez-home');
    const run = await execFile(process.execPath, [cliPath, 'run', 'mock:done', '--repo', fixtureRepo], {
      cwd: consumerDir,
      env: { ...process.env, XEZ_DRY_RUN: '1', XEZ_HOME: xezHome },
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.match(run.stdout, /run (done|review)/);

    const runs = JSON.parse(await readFile(join(fixtureRepo, '.local', 'xezar', 'runs.json'), 'utf8')) as Array<{
      status: string;
    }>;
    assert.equal(runs.length, 1);
    assert.ok(['done', 'review'].includes(runs[0]?.status ?? ''), 'the dry-run workflow should finish successfully');

    // Boot wiring (spec 2026-07-20-multi-project-workspace, step 1.5): the
    // headless run migrated ~/.xezar and registered the boot repo.
    const workspace = JSON.parse(await readFile(join(xezHome, 'config.json'), 'utf8')) as {
      schemaVersion: number;
      disabledProviders?: string[];
      projects: Array<{ name: string; root: string }>;
    };
    assert.ok(workspace.schemaVersion >= 1, 'boot runs the workspace migrations');
    assert.ok(
      workspace.projects.some((p) => p.name === 'fixture-repo'),
      'a headless run registers the boot repo in the workspace registry',
    );

    workspace.disabledProviders = ['claude'];
    await writeFile(join(xezHome, 'config.json'), `${JSON.stringify(workspace, null, 2)}\n`, 'utf8');
    await assert.rejects(
      execFile(process.execPath, [cliPath, 'run', 'mock:done must stay blocked', '--repo', fixtureRepo], {
        cwd: consumerDir,
        env: { ...process.env, XEZ_DRY_RUN: '1', XEZ_HOME: xezHome },
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
      }),
      (error: unknown) => {
        const result = error as { stderr?: string };
        assert.match(result.stderr ?? '', /Claude Code is disabled/);
        return true;
      },
      'headless run must honor the global provider preference',
    );
    const runsAfterDisabledAttempt = JSON.parse(
      await readFile(join(fixtureRepo, '.local', 'xezar', 'runs.json'), 'utf8'),
    ) as Array<{ status: string }>;
    assert.equal(runsAfterDisabledAttempt.length, 1, 'a disabled provider must not create a run');
    workspace.disabledProviders = [];
    await writeFile(join(xezHome, 'config.json'), `${JSON.stringify(workspace, null, 2)}\n`, 'utf8');

    const claudeShim = join(root, 'claude-shim.mjs');
    await writeFile(
      claudeShim,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.join(' ') === 'auth status --json') {
  process.stdout.write('{"loggedIn":true}\\n');
} else {
  process.stdout.write('{"type":"system","subtype":"init","session_id":"auth-failure-session"}\\n');
  process.stdout.write('{"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate. API Error: 401 OAuth access token has been revoked.","usage":{"input_tokens":0,"output_tokens":0},"total_cost_usd":0}\\n');
}
`,
      { mode: 0o755 },
    );
    await execFile(
      process.execPath,
      [cliPath, 'run', 'exercise runtime auth rejection', '--repo', fixtureRepo],
      {
        cwd: consumerDir,
        env: {
          ...process.env,
          XEZ_CLAUDE_BIN: claudeShim,
          XEZ_HOME: xezHome,
        },
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    ).catch(() => undefined);
    const runsAfterAuthFailure = JSON.parse(
      await readFile(join(fixtureRepo, '.local', 'xezar', 'runs.json'), 'utf8'),
    ) as Array<{ id: string }>;
    assert.equal(runsAfterAuthFailure.length, 2, 'the runtime-auth fixture creates exactly one run');
    const authFailureRun = runsAfterAuthFailure.at(0);
    assert.ok(authFailureRun, 'the auth-failure fixture creates a run');
    const authFailureEvents = (await readFile(
      join(fixtureRepo, '.local', 'xezar', 'runs', `${authFailureRun.id}.ndjson`),
      'utf8',
    )).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(
      authFailureEvents.some((event) =>
        event.type === 'provider-auth-required'
        && event.provider === 'claude'
        && typeof event.authFailureId === 'string'),
      'headless runtime rejection must persist provider recovery guidance',
    );

    // `xezar projects` (step 5.2) reads the same registry with no server
    // running — the ssh-into-the-box view of Settings → Projects.
    const projects = await execFile(process.execPath, [cliPath, 'projects'], {
      cwd: consumerDir,
      env: { ...process.env, XEZ_HOME: xezHome },
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.match(projects.stdout, /fixture-repo/);
    assert.match(projects.stdout, /1 project\(s\)/);

    // server-install / server-uninstall dry-run round-trip. A separate XEZ_HOME
    // isolates ~/.xezar/server.json from the project-registry fixture above;
    // XEZ_DRY_RUN performs no real sudo.
    assert.match(help.stdout, /xezar server-install/);
    const serverHome = join(root, 'server-home');
    const serverEnv = { ...process.env, XEZ_DRY_RUN: '1', XEZ_HOME: serverHome };
    const serverExec = { cwd: consumerDir, env: serverEnv, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 } as const;

    await execFile(
      process.execPath,
      [cliPath, 'server-install', '--platform', 'ubuntu-vps', '--yes', '--repo', fixtureRepo],
      serverExec,
    );
    const state = JSON.parse(await readFile(join(serverHome, 'server.json'), 'utf8')) as {
      platform: string;
      installed: boolean;
      steps: Record<string, unknown>;
    };
    assert.equal(state.platform, 'ubuntu-vps', 'server-install records the platform');
    assert.equal(state.installed, true, 'server-install flips installed=true when all required steps are done');
    assert.ok(state.steps['nginx-proxy'], 'server-install ran the nginx-proxy step');

    await execFile(
      process.execPath,
      [cliPath, 'server-uninstall', '--platform', 'ubuntu-vps', '--yes'],
      serverExec,
    );
    const reversed = JSON.parse(await readFile(join(serverHome, 'server.json'), 'utf8')) as {
      installed: boolean;
      steps: Record<string, unknown>;
    };
    assert.deepEqual(reversed.steps, {}, 'server-uninstall reverses every step');
    assert.equal(reversed.installed, false, 'server-uninstall clears installed');

    await execFile(
      process.execPath,
      [cliPath, 'server-install', '--platform', 'ubuntu-vps', '--external-proxy', '--yes', '--repo', fixtureRepo],
      serverExec,
    );
    await execFile(
      process.execPath,
      [cliPath, 'server-install', '--platform', 'ubuntu-vps', '--yes', '--repo', fixtureRepo],
      serverExec,
    );
    const resumedExternal = JSON.parse(await readFile(join(serverHome, 'server.json'), 'utf8')) as {
      externalProxy?: boolean;
      steps: Record<string, unknown>;
    };
    assert.equal(resumedExternal.externalProxy, true, 'a flag-less resume preserves external-proxy mode');
    assert.ok(!resumedExternal.steps['nginx-proxy'], 'a flag-less resume does not add xezar-managed nginx');

    // Unknown platform exits non-zero.
    await assert.rejects(
      execFile(process.execPath, [cliPath, 'server-install', '--platform', 'nope'], serverExec),
      'unknown platform should exit 1',
    );

    // `xezar init` — the first command a new user types. It scaffolds the
    // `.xezar/` project kit, and BACKWARD_COMPATIBILITY.md lists it as a
    // protected CLI surface whose load-bearing rule is stated in AGENTS.md:
    // init NEVER overwrites an existing file. Both failure modes are silent —
    // an empty kit, or a workflow the user authored quietly replaced.
    // A throwing `execFile` is a non-zero exit, so every call below that
    // resolves has also asserted `init` exited 0.
    const initRepo = join(root, 'init-repo');
    await mkdir(initRepo);
    await execFile('git', ['init', '--initial-branch=main'], { cwd: initRepo });
    // XEZ_HOME keeps the run off the developer's real ~/.xezar, and keeps it
    // clear of the `$HOME`-launch branch in `projectKitDir`.
    const initEnv = { ...process.env, XEZ_HOME: join(root, 'init-home') };
    const initExec = { cwd: initRepo, env: initEnv, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 } as const;

    const kitWorkflow = join(initRepo, '.xezar', 'workflows', 'fix-and-verify.yaml');
    const kitSkill = join(initRepo, '.xezar', 'skills', 'project-conventions.md');
    const dataIgnore = join(initRepo, '.local', '.gitignore');

    const firstInit = await execFile(process.execPath, [cliPath, 'init'], initExec);
    assert.match(firstInit.stdout, /fix-and-verify\.yaml/, 'init reports the workflow it wrote');
    assert.match(
      await readFile(kitWorkflow, 'utf8'),
      /^name: fix-and-verify$/m,
      'init scaffolds the example workflow',
    );
    assert.match(
      await readFile(kitSkill, 'utf8'),
      /^name: project-conventions$/m,
      'init scaffolds the example skill',
    );
    assert.match(await readFile(dataIgnore, 'utf8'), /^\*$/m, 'init keeps run state out of git history');

    // A second init over the untouched scaffold changes nothing at all.
    const afterFirstInit = await snapshotTree(initRepo);
    const secondInit = await execFile(process.execPath, [cliPath, 'init'], initExec);
    assert.match(secondInit.stdout, /exists, left untouched/, 'init says it skipped the existing files');
    assert.deepEqual(
      await snapshotTree(initRepo),
      afterFirstInit,
      'a second init must leave every existing file byte-identical',
    );

    // The rule that matters: work the user authored survives. A hand-edited kit
    // file, a hand-authored file inside `.xezar/`, and a file init never created.
    const handEdited = 'name: fix-and-verify\n# hand edited by the user — must survive init\n';
    await writeFile(kitWorkflow, handEdited, 'utf8');
    const ownSkill = join(initRepo, '.xezar', 'skills', 'house-rules.md');
    await writeFile(ownSkill, '# my own skill\n', 'utf8');
    const unrelated = join(initRepo, 'NOTES.md');
    await writeFile(unrelated, '# nothing to do with xezar\n', 'utf8');

    const beforeThirdInit = await snapshotTree(initRepo);
    await execFile(process.execPath, [cliPath, 'init'], initExec);
    assert.deepEqual(
      await snapshotTree(initRepo),
      beforeThirdInit,
      'init over a hand-edited kit must leave every file byte-identical',
    );
    assert.equal(
      await readFile(kitWorkflow, 'utf8'),
      handEdited,
      'init must never overwrite a workflow the user edited',
    );
    assert.equal(await readFile(ownSkill, 'utf8'), '# my own skill\n', 'init must not touch a user-authored skill');
    assert.equal(
      await readFile(unrelated, 'utf8'),
      '# nothing to do with xezar\n',
      'init must not touch files it did not create',
    );

    // `xezar serve` — the DEFAULT command, so a bare `xezar` is this boot. It
    // does four things beyond starting an HTTP server, and each of them fails
    // quietly: it picks the next free port when the requested one is taken
    // (BACKWARD_COMPATIBILITY.md §1/§3), it honours `--repo`, it sweeps
    // orphaned worktrees at startup (spec 006), and it keeps
    // `<repo>/.local/.gitignore` blanket-ignoring run state — the upkeep whose
    // absence once put run state into a user's history.
    // Every boot goes through `withServe`, which always stops the process and
    // always proves the port went free again: a stray listener would poison
    // every later run on this machine.
    const serveRepo = join(root, 'serve-repo');
    await mkdir(serveRepo);
    await execFile('git', ['init', '--initial-branch=main'], { cwd: serveRepo });
    await writeFile(join(serveRepo, 'README.md'), '# serve fixture\n', 'utf8');
    await execFile('git', ['add', 'README.md'], { cwd: serveRepo });
    await execFile(
      'git',
      ['-c', 'user.name=Xezar CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'serve fixture'],
      { cwd: serveRepo },
    );

    // A worktree directory with no matching run in `runs.json` — what a killed
    // cockpit leaves behind. The store here is empty, so this entry is orphaned.
    const orphanId = '00000000-dead-4000-8000-000000000001';
    const orphanDir = join(serveRepo, '.local', 'xezar', 'worktrees', orphanId);
    await mkdir(orphanDir, { recursive: true });
    await writeFile(join(orphanDir, 'leftover.txt'), 'abandoned worktree\n', 'utf8');

    // XEZ_HOME pins the workspace registry to a temp dir, XEZ_DRY_RUN keeps the
    // boot off the real agent CLIs, XEZ_NO_BANNER keeps the skills banner out of
    // the captured output.
    const serveEnv = {
      ...process.env,
      XEZ_DRY_RUN: '1',
      XEZ_HOME: join(root, 'serve-home'),
      XEZ_NO_BANNER: '1',
    };
    const wantedPort = await freePort();
    const firstBoot = await withServe(
      cliPath,
      ['--port', String(wantedPort), '--repo', serveRepo],
      { cwd: consumerDir, env: serveEnv },
      async ({ read, port }) => {
        assert.equal(port, wantedPort, 'a free requested port is the port serve uses');
        assert.equal(await healthStatus(port), 200, 'GET /api/v1/health answers 200 on the booted port');
        assert.match(
          read(),
          new RegExp(`cleaned 1 orphaned worktree\\(s\\): ${orphanId.slice(0, 8)}`),
          'the boot reports the orphaned worktree it swept',
        );
      },
    );
    assert.equal(
      await exists(orphanDir),
      false,
      'startup prunes a worktree directory whose run no longer exists',
    );
    assert.match(
      await readFile(join(serveRepo, '.local', '.gitignore'), 'utf8'),
      /^\*$/m,
      'a boot keeps run state out of the repository history',
    );
    // `--repo` is the whole reason the boot above touched `serve-repo` at all:
    // the process working directory is `consumerDir`, which is not a git repo.
    assert.match(firstBoot, /serve-repo$/m, 'serve reports the --repo directory as its root');
    assert.match(firstBoot, /branch main/, 'serve reads git state from the --repo directory');
    assert.equal(
      await exists(join(consumerDir, '.local')),
      false,
      '--repo must keep every boot write out of the process working directory',
    );

    // Port fallback: hold the requested port with a listener this test owns, so
    // the boot has to move. "address in use" instead of a cockpit is the failure
    // this pins.
    const busyPort = await freePort();
    const squatter = createServer();
    squatter.listen(busyPort, '127.0.0.1');
    await once(squatter, 'listening');
    try {
      const fallbackBoot = await withServe(
        cliPath,
        ['--port', String(busyPort), '--repo', serveRepo],
        { cwd: consumerDir, env: serveEnv },
        async ({ port }) => {
          assert.notEqual(port, busyPort, 'a taken port must not be the port serve uses');
          assert.equal(await healthStatus(port), 200, 'the fallback port serves the cockpit');
        },
      );
      assert.match(
        fallbackBoot,
        new RegExp(`port ${busyPort} was busy`),
        'serve says on stdout that the requested port was taken',
      );
    } finally {
      squatter.close();
      await once(squatter, 'close');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A port that is free right now: bind :0, read what the OS handed out, release it. */
async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert.ok(address && typeof address === 'object', 'the probe socket should report a port');
  const port = address.port;
  probe.close();
  await once(probe, 'close');
  return port;
}

/** True when nothing is listening on `port` — the no-server-left-behind check. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const probe = createServer();
    probe.once('error', () => resolveFree(false));
    probe.once('listening', () => probe.close(() => resolveFree(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(100);
  }
  return false;
}

const COCKPIT_LINE = /cockpit → http:\/\/localhost:(\d+)/;

/**
 * `GET /api/v1/health`, with a bound on the wait. A socket that accepts and
 * never answers — which is exactly what a bare listener on a squatted port does
 * — would otherwise hang the whole suite instead of failing an assertion.
 */
async function healthStatus(port: number): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
    signal: AbortSignal.timeout(15_000),
  });
  return res.status;
}

/**
 * Boot the packaged CLI's default command, run `body` against the port it
 * actually chose, then stop it. The process is killed in a `finally` and the
 * port is confirmed free afterwards, whatever the body did — a serve process
 * that outlived its test would break every later run on the same machine.
 * Returns everything the boot printed.
 */
async function withServe(
  cliPath: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
  body: (session: { read: () => string; port: number }) => Promise<void>,
): Promise<string> {
  const child = spawn(process.execPath, [cliPath, 'serve', '--no-open', ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { output += chunk; });

  // Last-resort reaper: a test that times out or throws in an unexpected place
  // still unwinds through process exit, and the child must not outlive it.
  const reap = () => { child.kill('SIGKILL'); };
  process.once('exit', reap);
  // Subscribed HERE, before anything can be awaited: a boot that crashes on its
  // own (a busy port with no fallback does exactly that) emits `exit` while the
  // assertions are still running, and a listener attached afterwards would wait
  // for an event that already happened — a hang instead of a failure.
  const exited = once(child, 'exit').catch(() => undefined);
  let dead = false;
  void exited.then(() => { dead = true; });

  let port = 0;
  let failure: unknown;
  try {
    // A crashed boot ends the wait immediately — no point spending the timeout
    // watching a process that is already gone.
    await waitUntil(() => COCKPIT_LINE.test(output) || dead, 60_000);
    assert.match(output, COCKPIT_LINE, `serve never printed its cockpit line. Output:\n${output}`);
    port = Number(COCKPIT_LINE.exec(output)?.[1]);
    await body({ read: () => output, port });
  } catch (err) {
    failure = err;
  } finally {
    child.kill('SIGTERM');
    // The losing side of this race must be cancelled: a pending 10 s timer would
    // hold the test process open long after the assertions finished.
    const giveUp = new AbortController();
    const stopped = await Promise.race([
      exited.then(() => true),
      sleep(10_000, false, { signal: giveUp.signal }).catch(() => false),
    ]);
    giveUp.abort();
    if (!stopped) {
      child.kill('SIGKILL');
      await exited;
    }
    process.off('exit', reap);
  }

  const freed = port > 0 ? await waitUntil(() => portIsFree(port), 10_000) : true;
  if (failure) throw failure;
  assert.ok(freed, `serve left a listener behind on port ${port}`);
  return output;
}
