import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

// The scripts under test are the REPO's, not this package's: `.ai/` is agent-pipeline tooling
// that spans every workspace, so it stays at the root.
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
const http = require('node:http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': req.url === '/api/health' ? 'application/json' : 'text/html' });
  res.end(req.url === '/api/health' ? '{"ok":true}' : '<!doctype html>');
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
