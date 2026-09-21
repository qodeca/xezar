import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join, relative, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

// The scripts under test are the REPO's, not this package's: `.xezar/pipeline/` is agent-pipeline
// tooling that spans every workspace, so it stays at the root.
const repoRoot = resolve(import.meta.dirname, '../../../..');
const fixtures: string[] = [];
const launchedPids = new Set<number>();

afterEach(() => {
  for (const pid of launchedPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The down script already stopped the fixture process.
    }
  }
  launchedPids.clear();
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function commandPath(command: string): string {
  return execFileSync('/bin/sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).trim();
}

const hasSetsid = spawnSync('/bin/sh', ['-c', 'command -v setsid'], { stdio: 'ignore' }).status === 0;

function makeFixture(withSetsid: boolean): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'xez-test-env-launcher-'));
  fixtures.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'docs/testing'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  copyFileSync(join(repoRoot, 'scripts/test-env-up.sh'), join(root, 'scripts/test-env-up.sh'));
  copyFileSync(join(repoRoot, 'scripts/test-env-down.sh'), join(root, 'scripts/test-env-down.sh'));
  writeFileSync(join(root, 'docs/testing/agent-browser.md'), '# test provider\n');
  writeFileSync(join(root, 'package.json'), '{"private":true}\n');
  writeFileSync(join(root, 'package-lock.json'), '{}\n');

  const commands = ['cat', 'chmod', 'curl', 'date', 'dirname', 'find', 'grep', 'id', 'kill', 'mkdir', 'mv', 'nohup', 'pwd', 'rm', 'sh', 'sleep', 'tail', 'uname'];
  if (withSetsid) commands.push('setsid');
  for (const command of commands) symlinkSync(commandPath(command), join(root, 'bin', command));
  symlinkSync(process.execPath, join(root, 'bin/node'));

  writeFileSync(
    join(root, 'bin/npm'),
    // Writes the same artifacts the real preparation chain produces, at the same paths —
    // the up script asserts on them by name (BUILD_ARTIFACTS), so this stub has to follow
    // the workspace layout rather than invent its own.
    `#!/bin/sh
set -eu
mkdir -p node_modules/zod packages/xezar/dist packages/xezar/web/dist
printf '{"name":"zod"}' > node_modules/zod/package.json
cat > packages/xezar/dist/index.js <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const requestedPort = Number(process.argv[process.argv.indexOf('--port') + 1]);
const repo = process.argv[process.argv.indexOf('--repo') + 1] ?? process.cwd();
// What this boot actually SAW and what the launcher actually ASKED FOR, so a spec can assert the
// layout input arrived rather than infer it from the descriptor the launcher wrote itself.
const bootState = JSON.stringify({
  markerAtBoot: fs.existsSync(path.join(repo, '.xezar/workspace.json')),
  layoutFlag: process.argv.includes('--global-layout'),
  argv: process.argv.slice(2),
});
const taskEnv = JSON.stringify({
  handoff: process.env.XEZ_HANDOFF_FILE ?? null,
  todos: process.env.XEZ_TODOS_FILE ?? null,
  taskId: process.env.XEZ_TASK_ID ?? null,
});
// Name the pid from the first instant, so a test that kills the LAUNCHER can still clean up this
// app, and let the caller hold the listener back so the kill lands inside the boot window rather
// than after it (the crash case, review of #657 M2).
fs.writeFileSync(path.join(repo, '.local/qa/app.pid'), String(process.pid));
// The real app's bind contract (#238): --port is a REQUEST, and a port taken at bind time
// moves the app to the next one, which it then PRINTS. This stub mirrors that so the launcher's
// port reading is exercised. XEZ_TEST_TAKE_PORT_AT_BIND manufactures the takeover
// deterministically: a thief binds the requested port first, exactly as a peer process would
// between the old probe and this bind. The thief ignores its own bind error, because a port
// already held by somebody else is just as taken.
let port = requestedPort;
const serve = () => {
  const server = http.createServer((req, res) => {
    const json = req.url === '/api/health' || req.url === '/api/task-env' || req.url === '/api/boot-state';
    res.writeHead(200, { 'content-type': json ? 'application/json' : 'text/html' });
    res.end(req.url === '/api/health' ? '{"ok":true}' : req.url === '/api/task-env' ? taskEnv : req.url === '/api/boot-state' ? bootState : '<!doctype html>');
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < requestedPort + 50) { port += 1; server.listen(port, '127.0.0.1'); return; }
    console.error(err);
    process.exit(1);
  });
  server.once('listening', () => {
    console.log('  cockpit → http://localhost:' + port);
    // Real startup prints later product copy containing "cockpit" but no URL. The launcher must
    // read the boot URL itself, not whichever line happened to use that word last.
    console.log('  reusable skills for your cockpit');
  });
  server.listen(port, '127.0.0.1');
};
setTimeout(() => {
  if (process.env.XEZ_TEST_TAKE_PORT_AT_BIND === '1') {
    const thief = net.createServer();
    thief.on('error', () => serve());
    thief.once('listening', () => serve());
    thief.listen(requestedPort, '127.0.0.1');
  } else serve();
}, Number(process.env.XEZ_TEST_BOOT_DELAY_MS ?? '0'));
EOF
printf '<!doctype html>' > packages/xezar/web/dist/index.html
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(root, 'bin/agent-browser'),
    `#!/bin/sh
case "\${1:-}" in
  doctor) printf '{"ok":true}\\n' ;;
  --version) printf 'test-browser 1\\n' ;;
  *) : ;;
esac
`,
    { mode: 0o755 },
  );
  return { root, path: join(root, 'bin') };
}

function descriptor(root: string): { baseUrl: string; app: { pid: number; port: number } } {
  return JSON.parse(readFileSync(join(root, '.local/qa/test-env.json'), 'utf8')) as {
    baseUrl: string;
    app: { pid: number; port: number };
  };
}

/**
 * Everything under a fixture's repository root except the two places a boot is ALLOWED to write:
 * `.local/` (this launcher's own directory, and the runtime state a test run rewrites) and the
 * build outputs under `node_modules/` and `dist/`. A listing that changes outside those is a
 * launcher that moved, renamed or created something in the checkout — the failure the #657 review
 * reproduced as B2, where a SIGKILL left the repository's own committed `workspace.json` at a
 * backup name with nothing to say so.
 */
function repoRootEntries(root: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      if (entry.isDirectory()) {
        if (rel === '.local' || rel === 'node_modules' || entry.name === 'dist') continue;
        walk(path);
      } else {
        entries.push(rel);
      }
    }
  };
  walk(root);
  return entries;
}

/** Poll `check` until it answers true, or fail with what was being waited for. */
async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

/** A loopback port that is free right now, for a fixture that must not depend on 4321. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const address = probe.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

/**
 * The reuse check must survive `startedAt`'s one-second resolution.
 *
 * `write_descriptor` stamps `startedAt` with `date -u +%FT%TZ`, which truncates to whole
 * seconds. The freshness check used to compare tracked sources against that string with
 * `find -newermt`, which compares with sub-second precision — so a source file last touched
 * anywhere inside the boot's own second read as "changed since boot", and the environment was
 * needlessly rebuilt from scratch. It reproduced only when the boot was fast enough to finish
 * inside that second, which is why it looked like a CI-only flake.
 *
 * This pins it deterministically by manufacturing the exact timing rather than racing for it.
 */
test('reuses an instance whose sources were last touched inside the boot second', { timeout: 60_000 }, async () => {
  const fixture = makeFixture(hasSetsid);
  const env = { ...process.env, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
  const up = join(fixture.root, 'scripts/test-env-up.sh');
  const down = join(fixture.root, 'scripts/test-env-down.sh');

  const cold = spawnSync('/bin/sh', [up], { cwd: tmpdir(), encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(cold.status, 0, cold.stderr);
  const first = descriptor(fixture.root);
  launchedPids.add(first.app.pid);

  // The race, made exact: a tracked input 0.5s into the boot second, the descriptor 0.9s in,
  // and `startedAt` truncated to the second — precisely what a fast boot produces.
  const descriptorPath = join(fixture.root, '.local/qa/test-env.json');
  const second = Math.floor(Date.now() / 1000);
  const record = JSON.parse(readFileSync(descriptorPath, 'utf8')) as Record<string, unknown>;
  record.startedAt = `${new Date(second * 1000).toISOString().slice(0, 19)}Z`;
  writeFileSync(descriptorPath, `${JSON.stringify(record, null, 2)}\n`);
  utimesSync(join(fixture.root, 'package.json'), second + 0.5, second + 0.5);
  utimesSync(descriptorPath, second + 0.9, second + 0.9);

  const warm = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(warm.status, 0, warm.stderr);
  assert.match(
    warm.stdout,
    /TEST_ENV_REUSED=1/,
    `a source touched inside the boot second is not a change.\n--- warm stderr ---\n${warm.stderr}`,
  );
  assert.equal(descriptor(fixture.root).app.pid, first.app.pid);

  spawnSync('/bin/sh', [down], { encoding: 'utf8', env, timeout: 20_000 });
  launchedPids.delete(first.app.pid);
});

/**
 * #600 SP-5.6 — the single-project marker as a reuse dimension.
 *
 * A repository root holding `.xezar/workspace.json` is a different checkout from one that does
 * not: the file is committed state that a spec's `git status` and the `repo-git` assertions see,
 * and the mode it selects is the one the suite must not boot in. The launcher now ASKS for the
 * global layout (`--global-layout`, #657) rather than moving the file, but the boot condition still
 * differs, so an instance booted under the other condition must not be reused. Nothing else in the
 * reuse check notices: `.xezar/` is not a build input and the pins are equal.
 */
test('never reuses an instance across a change in the repository single-project marker', { timeout: 60_000 }, async () => {
  const fixture = makeFixture(hasSetsid);
  const env = { ...process.env, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
  const up = join(fixture.root, 'scripts/test-env-up.sh');
  const down = join(fixture.root, 'scripts/test-env-down.sh');
  const descriptorPath = join(fixture.root, '.local/qa/test-env.json');
  const markerOf = (): unknown =>
    (JSON.parse(readFileSync(descriptorPath, 'utf8')) as { environment: { singleProjectRoot?: unknown } })
      .environment.singleProjectRoot;

  const cold = spawnSync('/bin/sh', [up], { cwd: tmpdir(), encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(cold.status, 0, cold.stderr);
  const withoutMarker = descriptor(fixture.root);
  launchedPids.add(withoutMarker.app.pid);
  assert.equal(markerOf(), false);

  // The same checkout now carries the marker. The pins, the build and the TTL are all unchanged, so
  // only this dimension can tell the running instance was booted under the other condition.
  mkdirSync(join(fixture.root, '.xezar'), { recursive: true });
  writeFileSync(join(fixture.root, '.xezar/workspace.json'), '{}\n');
  const withMarkerRun = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(withMarkerRun.status, 0, withMarkerRun.stderr);
  assert.match(
    withMarkerRun.stdout,
    /TEST_ENV_REUSED=0/,
    `an instance booted without the marker was reused for a marker-carrying root.\n--- stderr ---\n${withMarkerRun.stderr}`,
  );
  const withMarker = descriptor(fixture.root);
  launchedPids.add(withMarker.app.pid);
  assert.notEqual(withMarker.app.pid, withoutMarker.app.pid);
  assert.equal(markerOf(), true);

  // And back: an instance booted under the marker is never reused once it is gone.
  rmSync(join(fixture.root, '.xezar'), { recursive: true, force: true });
  const markerGoneRun = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(markerGoneRun.status, 0, markerGoneRun.stderr);
  assert.match(markerGoneRun.stdout, /TEST_ENV_REUSED=0/);
  const markerGone = descriptor(fixture.root);
  launchedPids.add(markerGone.app.pid);
  assert.equal(markerOf(), false);

  spawnSync('/bin/sh', [down], { encoding: 'utf8', env, timeout: 20_000 });
  launchedPids.delete(markerGone.app.pid);
});

/**
 * The launcher reports the port the app really holds, not the one it probed and released.
 *
 * #238 removed exactly this shape from the product: a port proved free and then released can be
 * taken before the real bind, and a boot that trusts the probed port polls a URL with nobody
 * behind it. The launcher still had it (`port_free`/`free_port`). The race is MANUFACTURED here
 * rather than raced: the stub takes the requested port for itself at bind time
 * (`XEZ_TEST_TAKE_PORT_AT_BIND`), exactly as a peer process would between the probe and the bind,
 * then falls back to the next port the way the real app does and prints the port it holds. The
 * descriptor must name THAT port and it must answer.
 */
test('reports the port the app really holds when the probed port is taken at bind time', { timeout: 60_000 }, async () => {
  // BREAK-671-ENV-PORT. The app's emitted boot URL is the deterministic signal; neither a
  // released availability probe nor the last unrelated log line containing “cockpit” owns it.
  const fixture = makeFixture(hasSetsid);
  // A port this test knows is free, so the case does not depend on 4321 being free on the
  // machine (a developer's cockpit, a peer run's instance). The launcher requests it, the stub
  // takes it at bind time, and the app must move to the next port and be reported there.
  const requested = await freePort();
  const env = {
    ...process.env,
    PATH: fixture.path,
    TEST_ENV_CACHE_TTL_SECONDS: '600',
    TEST_ENV_PREFERRED_PORT: String(requested),
    XEZ_TEST_TAKE_PORT_AT_BIND: '1',
  };
  const up = join(fixture.root, 'scripts/test-env-up.sh');
  const down = join(fixture.root, 'scripts/test-env-down.sh');

  const cold = spawnSync('/bin/sh', [up], { cwd: tmpdir(), encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(cold.status, 0, cold.stderr);
  const started = descriptor(fixture.root);
  launchedPids.add(started.app.pid);
  assert.notEqual(started.app.port, requested, 'the descriptor named the requested port, which the app does not hold');
  const health = await fetch(`${started.baseUrl}/api/v1/health`);
  assert.equal(health.status, 200, 'the descriptor URL must answer');

  spawnSync('/bin/sh', [down], { encoding: 'utf8', env, timeout: 20_000 });
  launchedPids.delete(started.app.pid);
});

/**
 * The launcher ASKS for the global layout, and touches nothing in the repository root (#657).
 *
 * The suite must boot in the pinned global layout even when the repository carries
 * `.xezar/workspace.json` — the mode never opens `XEZ_HOME`
 * (`docs/guide/11-configuration-reference.md`) — and it says so with the app's own explicit
 * `--global-layout` input, which outranks the marker. An earlier version of this launcher renamed
 * the marker aside for the app's boot instead. Review of #657 (B1-B3) rejected that: an unlocked
 * rename of a checkout's committed state is unsafe while another process — a peer agent, the
 * cockpit served from that very checkout — may be reading it, and no trap makes the crash window
 * safe. So the assertion is two-sided: the app was TOLD (the flag arrived), and the checkout is
 * untouched (the marker is byte-identical and nothing in the repository root appeared, moved or
 * vanished).
 */
test('boots the marker-carrying repository in the global layout by asking for it, touching nothing', { timeout: 60_000 }, async () => {
  const fixture = makeFixture(hasSetsid);
  const env = { ...process.env, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
  const up = join(fixture.root, 'scripts/test-env-up.sh');
  const down = join(fixture.root, 'scripts/test-env-down.sh');
  const marker = join(fixture.root, '.xezar/workspace.json');
  const descriptorPath = join(fixture.root, '.local/qa/test-env.json');
  mkdirSync(join(fixture.root, '.xezar'), { recursive: true });
  writeFileSync(marker, '{"schemaVersion":1}\n');
  const before = repoRootEntries(fixture.root);

  const cold = spawnSync('/bin/sh', [up], { cwd: tmpdir(), encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(cold.status, 0, cold.stderr);
  const started = descriptor(fixture.root);
  launchedPids.add(started.app.pid);

  const boot = (await fetch(`${started.baseUrl}/api/boot-state`).then((response) =>
    response.json(),
  )) as { markerAtBoot: boolean; layoutFlag: boolean; argv: string[] };
  assert.equal(
    boot.layoutFlag,
    true,
    `the launcher did not pass --global-layout (the app was started with: ${boot.argv.join(' ')})`,
  );
  assert.equal(boot.markerAtBoot, true, 'the launcher moved the repository marker aside for the boot');
  assert.deepEqual(repoRootEntries(fixture.root), before, 'the launcher changed something in the repository root');
  assert.equal(readFileSync(marker, 'utf8'), '{"schemaVersion":1}\n');
  // The descriptor's fingerprint is DERIVED from the input the launcher passed, so it says what
  // the command line asked for rather than a literal beside it (review of #657, M1).
  const recorded = JSON.parse(readFileSync(descriptorPath, 'utf8')) as { environment: { stateLayout: string } };
  assert.equal(recorded.environment.stateLayout, 'global');

  // Nothing was moved, so nothing has to be put back: the same warm run reuses the same instance
  // rather than booting again, with the marker untouched in between.
  const warm = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(warm.status, 0, warm.stderr);
  assert.match(warm.stdout, /TEST_ENV_REUSED=1/, `--- warm stderr ---\n${warm.stderr}`);
  assert.equal(descriptor(fixture.root).app.pid, started.app.pid);
  assert.deepEqual(repoRootEntries(fixture.root), before);
  assert.equal(readFileSync(marker, 'utf8'), '{"schemaVersion":1}\n');

  const stopped = spawnSync('/bin/sh', [down], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(stopped.status, 0, stopped.stderr);
  launchedPids.delete(started.app.pid);
});

/**
 * A launcher killed inside its own boot leaves the repository untouched (#657 review, M2).
 *
 * The old mechanism's whole risk was "what is left on disk when this dies": a SIGKILL inside the
 * hide window left the repository's committed `workspace.json` at a backup name, with no message
 * and no breadcrumb until somebody happened to run the launcher again. With no disk state touched
 * the case is trivial — which is the point — but it is pinned here so a later change cannot
 * reintroduce a rename without failing this. The kill is made deterministic rather than raced: the
 * stub app holds its listener back (`XEZ_TEST_BOOT_DELAY_MS`) and names its own pid immediately, so
 * the launcher is still waiting on health, inside its boot, when it dies.
 */
test('a launcher killed mid-boot leaves the repository untouched', { timeout: 60_000 }, async () => {
  const fixture = makeFixture(hasSetsid);
  const env = {
    ...process.env,
    PATH: fixture.path,
    TEST_ENV_CACHE_TTL_SECONDS: '600',
    XEZ_TEST_BOOT_DELAY_MS: '5000',
  };
  const up = join(fixture.root, 'scripts/test-env-up.sh');
  const down = join(fixture.root, 'scripts/test-env-down.sh');
  const marker = join(fixture.root, '.xezar/workspace.json');
  const appPidFile = join(fixture.root, '.local/qa/app.pid');
  mkdirSync(join(fixture.root, '.xezar'), { recursive: true });
  writeFileSync(marker, '{"schemaVersion":1}\n');
  const before = repoRootEntries(fixture.root);

  const launcher = spawn('/bin/sh', [up], { cwd: tmpdir(), env, stdio: 'ignore' });
  try {
    await waitFor(() => existsSync(appPidFile), 15_000, 'the stub app to name its pid');
    launchedPids.add(Number(readFileSync(appPidFile, 'utf8').trim()));
    assert.equal(launcher.exitCode, null, 'the launcher finished before the kill could land inside its boot');
    launcher.kill('SIGKILL');
    await new Promise((done) => launcher.once('exit', done));

    // SIGKILL runs no trap. There is nothing to restore, because nothing was ever moved.
    assert.deepEqual(repoRootEntries(fixture.root), before, 'the killed launcher left the repository changed');
    assert.equal(readFileSync(marker, 'utf8'), '{"schemaVersion":1}\n');
    assert.equal(existsSync(join(fixture.root, '.xezar/workspace.json.e2e-hidden')), false);
  } finally {
    if (launcher.exitCode === null) launcher.kill('SIGKILL');
    spawnSync('/bin/sh', [down], { encoding: 'utf8', env, timeout: 20_000 });
  }
});

test('launcher strips inherited task-control variables before starting the shared server', { timeout: 60_000 }, async () => {
  const fixture = makeFixture(hasSetsid);
  const env = {
    ...process.env,
    PATH: fixture.path,
    TEST_ENV_CACHE_TTL_SECONDS: '600',
    XEZ_HANDOFF_FILE: '/sentinel/handoff.md',
    XEZ_TODOS_FILE: '/sentinel/todos.json',
    XEZ_TASK_ID: 'sentinel-task',
  };
  const up = join(fixture.root, 'scripts/test-env-up.sh');
  const down = join(fixture.root, 'scripts/test-env-down.sh');

  const cold = spawnSync('/bin/sh', [up], { cwd: tmpdir(), encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(cold.status, 0, cold.stderr);
  const started = descriptor(fixture.root);
  launchedPids.add(started.app.pid);

  const taskEnv = await fetch(`${started.baseUrl}/api/task-env`).then((response) => response.json());
  assert.deepEqual(taskEnv, { handoff: null, todos: null, taskId: null });

  const stopped = spawnSync('/bin/sh', [down], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(stopped.status, 0, stopped.stderr);
  launchedPids.delete(started.app.pid);
});

for (const withSetsid of [true, false]) {
  test(
    `generated launcher survives its caller and stops by descriptor PID (${withSetsid ? 'setsid' : 'nohup fallback'})`,
    { skip: withSetsid && !hasSetsid ? 'setsid is not available on this platform' : false },
    async () => {
      const fixture = makeFixture(withSetsid);
      const env = { ...process.env, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
      const up = join(fixture.root, 'scripts/test-env-up.sh');
      const down = join(fixture.root, 'scripts/test-env-down.sh');
      const callerPidFile = join(fixture.root, 'caller.pid');

      const coldCommand = withSetsid ? commandPath('setsid') : '/bin/sh';
      const coldArgs = withSetsid
        ? ['/bin/sh', '-c', 'echo $$ > "$2"; sh "$1"', 'launcher-parent', up, callerPidFile]
        : ['-c', 'echo $$ > "$2"; sh "$1"', 'launcher-parent', up, callerPidFile];
      const cold = spawnSync(coldCommand, coldArgs, {
        cwd: tmpdir(),
        encoding: 'utf8',
        env,
        timeout: 20_000,
      });
      assert.equal(cold.status, 0, cold.stderr);
      assert.match(cold.stdout, /TEST_ENV_REUSED=0/);

      const first = descriptor(fixture.root);
      launchedPids.add(first.app.pid);
      if (withSetsid) {
        const callerPid = Number(readFileSync(callerPidFile, 'utf8').trim());
        try {
          process.kill(-callerPid, 'SIGTERM');
        } catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
      assert.equal(process.kill(first.app.pid, 0), true);
      const health = await fetch(`${first.baseUrl}/api/health`).then((response) => response.json());
      assert.deepEqual(health, { ok: true });

      const warm = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
      assert.equal(warm.status, 0, warm.stderr);
      // The script LOGS why it declined to reuse ("descriptor is stale", "source changed since
      // boot", …) and it logs to stderr. Asserting on stdout alone threw that away, which is
      // why a reuse failure here read as an unexplainable flake; carry it into the message.
      assert.match(
        warm.stdout,
        /TEST_ENV_REUSED=1/,
        `the warm run did not reuse the instance.\n--- warm stderr ---\n${warm.stderr}\n--- cold stderr ---\n${cold.stderr}`,
      );
      assert.equal(descriptor(fixture.root).app.pid, first.app.pid);

      const stopped = spawnSync('/bin/sh', [down], { encoding: 'utf8', env, timeout: 20_000 });
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.match(stopped.stdout, /TEST_ENV_STATUS=stopped/);
      assert.throws(() => process.kill(first.app.pid, 0));
      launchedPids.delete(first.app.pid);
    },
  );
}
