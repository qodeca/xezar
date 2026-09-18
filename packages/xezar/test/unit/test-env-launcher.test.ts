import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const repo = process.argv[process.argv.indexOf('--repo') + 1] ?? process.cwd();
const bootState = JSON.stringify({ markerAtBoot: fs.existsSync(path.join(repo, '.xezar/workspace.json')) });
const taskEnv = JSON.stringify({
  handoff: process.env.XEZ_HANDOFF_FILE ?? null,
  todos: process.env.XEZ_TODOS_FILE ?? null,
  taskId: process.env.XEZ_TASK_ID ?? null,
});
http.createServer((req, res) => {
  const json = req.url === '/api/health' || req.url === '/api/task-env' || req.url === '/api/boot-state';
  res.writeHead(200, { 'content-type': json ? 'application/json' : 'text/html' });
  res.end(req.url === '/api/health' ? '{"ok":true}' : req.url === '/api/task-env' ? taskEnv : req.url === '/api/boot-state' ? bootState : '<!doctype html>');
}).listen(port, '127.0.0.1');
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

function descriptor(root: string): { baseUrl: string; app: { pid: number } } {
  return JSON.parse(readFileSync(join(root, '.local/qa/test-env.json'), 'utf8')) as {
    baseUrl: string;
    app: { pid: number };
  };
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
 * A repository root holding `.xezar/workspace.json` would boot in single-project mode, where the
 * mode never opens the pinned `XEZ_HOME`. The launcher now hides the marker for the app's own boot
 * so the shared suite stays in the pinned global layout, but the boot path still differs, so an
 * instance booted under the other condition must not be reused. Nothing else in the reuse check
 * notices: `.xezar/` is not a build input and the pins are equal.
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
 * The marker is hidden for the app's boot, and only for it (#653).
 *
 * `resolveStateLayout` reads the marker once, at startup, and caches the answer for the life of the
 * process — so the launcher can move the file aside, boot, and put it straight back. This pins both
 * halves: the app that started saw no marker (so it opened the pinned `XEZ_HOME` rather than the
 * repository's own committed state), and every later reader — a spec's `git status`, a `xezar` a
 * spec spawns, the next reuse check — sees the repository exactly as it was.
 */
test('hides the single-project marker for the app boot and restores it before the specs run', { timeout: 60_000 }, async () => {
  const fixture = makeFixture(hasSetsid);
  const env = { ...process.env, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
  const up = join(fixture.root, 'scripts/test-env-up.sh');
  const down = join(fixture.root, 'scripts/test-env-down.sh');
  const marker = join(fixture.root, '.xezar/workspace.json');
  mkdirSync(join(fixture.root, '.xezar'), { recursive: true });
  writeFileSync(marker, '{"schemaVersion":1}\n');

  const cold = spawnSync('/bin/sh', [up], { cwd: tmpdir(), encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(cold.status, 0, cold.stderr);
  const started = descriptor(fixture.root);
  launchedPids.add(started.app.pid);

  const boot = (await fetch(`${started.baseUrl}/api/boot-state`).then((response) =>
    response.json(),
  )) as { markerAtBoot: boolean };
  assert.equal(boot.markerAtBoot, false, 'the app booted with the marker still in place');
  assert.equal(readFileSync(marker, 'utf8'), '{"schemaVersion":1}\n');

  // The restore happens before the descriptor is written, so a warm run reuses the same instance
  // rather than hiding the marker again for no reason.
  const warm = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(warm.status, 0, warm.stderr);
  assert.match(warm.stdout, /TEST_ENV_REUSED=1/, `--- warm stderr ---\n${warm.stderr}`);
  assert.equal(descriptor(fixture.root).app.pid, started.app.pid);
  assert.equal(readFileSync(marker, 'utf8'), '{"schemaVersion":1}\n');

  const stopped = spawnSync('/bin/sh', [down], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(stopped.status, 0, stopped.stderr);
  launchedPids.delete(started.app.pid);
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
