import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Per-project port memory through the REAL `serve` command (#467, AC-02/AC-03).
 *
 * `cli-settings.test.ts` proves the precedence rules on their own. This file proves the two
 * things only a running `serve` can: that the port it REMEMBERS is the port it actually holds,
 * and that a start with nothing asked for comes back to it. The CLI runs from source through
 * tsx, like `serve-port-race.test.ts`, so no build is needed.
 *
 * `named break:` comments mark the deliberate defect each case detects.
 *
 * Every process here is stopped by the PID this test started — never by pattern. A `pkill -f`
 * on anything from a skill or a script would match every peer agent on this machine (#156).
 */

const packageRoot = resolve(import.meta.dirname, '../..');
const entry = join(packageRoot, 'src', 'index.ts');
const tsxLoader = import.meta.resolve('tsx');
const COCKPIT_LINE = /cockpit → http:\/\/localhost:(\d+)/;
const START_PORT = /event=xezar\.ready[^\n]*\bstart=(\d+)/;

// `/tmp` explicitly, not `tmpdir()`: a task worktree's own TMPDIR sits INSIDE the repository,
// and `shouldRegisterProject` refuses to register anything under `.local/xezar/worktrees/`,
// so a fixture created there would never get a registry row to remember a port on.
const fixtureRoot = await mkdtemp(join(realpathSync('/tmp'), 'xez-port-memory-'));
const bindSeamPath = join(fixtureRoot, 'occupy-at-bind.mjs');
await writeFile(bindSeamPath, `
import net from 'node:net';
const busyPort = Number(process.env.XEZ_TEST_BUSY_AT_BIND);
const listen = net.Server.prototype.listen;
let occupied = false;
net.Server.prototype.listen = function (...args) {
  const options = typeof args[0] === 'object' && args[0] !== null
    ? args[0]
    : { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined };
  const port = Number(options.port);
  if (!occupied && Number.isInteger(busyPort) && busyPort > 0 && port === busyPort) {
    occupied = true;
    const sentinel = net.createServer();
    sentinel.on('error', () => {});
    listen.call(sentinel, busyPort, options.host ?? '127.0.0.1');
    sentinel.unref();
  }
  return listen.apply(this, args);
};
`, 'utf8');
after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

interface Boot {
  output: string;
  /** The port the cockpit line named, or undefined when no cockpit line was printed. */
  port: number | undefined;
  /** The resolved port request printed by the boot record, before bind-time fallback. */
  startPort: number | undefined;
  exitCode: number | null | undefined;
}

/** Boot `serve` in `repo` with `home` as its registry, wait for the cockpit line, stop it. */
async function bootServe(
  repo: string,
  home: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
): Promise<Boot> {
  const child = spawn(
    process.execPath,
    [
      '--import', tsxLoader,
      '--import', pathToFileURL(bindSeamPath).href,
      entry, 'serve', '--no-open', '--repo', repo, ...args,
    ],
    {
      cwd: repo,
      env: {
        ...process.env,
        XEZ_DRY_RUN: '1',
        XEZ_HOME: home,
        XEZ_NO_BANNER: '1',
        XEZ_SKILLS_AUTO_UPDATE: '0',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { output += chunk; });
  let exitCode: number | null | undefined;
  const exited = once(child, 'exit').then(([code]) => { exitCode = code as number | null; });
  const reap = () => { child.kill('SIGKILL'); };
  process.once('exit', reap);
  try {
    const deadline = Date.now() + 60_000;
    while (!COCKPIT_LINE.test(output) && exitCode === undefined && Date.now() < deadline) {
      await sleep(50);
    }
    const printed = COCKPIT_LINE.exec(output);
    const started = START_PORT.exec(output);
    return {
      output,
      port: printed ? Number(printed[1]) : undefined,
      startPort: started ? Number(started[1]) : undefined,
      exitCode,
    };
  } finally {
    if (exitCode === undefined) {
      child.kill('SIGTERM');
      const stopped = await Promise.race([exited.then(() => true), sleep(10_000, false)]);
      if (!stopped) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    process.off('exit', reap);
  }
}

/** One fixture: a folder to serve and its own isolated registry home. */
async function fixture(name: string): Promise<{ repo: string; home: string }> {
  const dir = await mkdtemp(join(fixtureRoot, `${name}-`));
  return { repo: dir, home: join(dir, 'home') };
}

interface RegistryRow {
  id?: string;
  root?: string;
  cli?: { port?: number };
  lastListen?: { port?: number; host?: string; observedAt?: string };
}

async function readRegistry(home: string): Promise<RegistryRow[]> {
  try {
    const raw = await readFile(join(home, 'config.json'), 'utf8');
    return (JSON.parse(raw) as { projects?: RegistryRow[] }).projects ?? [];
  } catch {
    return [];
  }
}

/** Ask the OS for a sentinel port and retain ownership until the assertion releases it. */
async function sentinel(): Promise<{ port: number; server: Server }> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { port: address.port, server };
}

async function release(server: Server): Promise<void> {
  server.close();
  await once(server, 'close');
}

test('a start remembers the port it really bound, and the next start comes back to it', { timeout: 180_000 }, async () => {
  const { repo, home } = await fixture('reuse');
  const wanted = await sentinel();

  // Keep the requested port occupied. The boot's `start` field then records the resolved request,
  // while its URL records the fallback it actually owns; neither assertion races a released probe.
  const first = await bootServe(repo, home, ['--port', String(wanted.port)]).finally(() => release(wanted.server));
  assert.equal(first.startPort, wanted.port, `the explicit port must be the resolved request. Output:\n${first.output}`);
  assert.ok(first.port, `serve must report the port it actually bound. Output:\n${first.output}`);
  const [row] = await readRegistry(home);
  assert.equal(row?.lastListen?.port, first.port, `the bound port must be remembered. Registry: ${JSON.stringify(row)}`);
  assert.equal(row?.lastListen?.host, '127.0.0.1');
  assert.ok(row?.lastListen?.observedAt, 'the hint must carry when it was observed');
  // A hint, not a claim: no pid, no lease, no socket path (analysis § 6(e)).
  assert.deepEqual(Object.keys(row?.lastListen ?? {}).sort(), ['host', 'observedAt', 'port']);

  // Nothing asked for this time. Without memory this would start at 4321.
  const second = await bootServe(repo, home, [], { XEZ_TEST_BUSY_AT_BIND: String(first.port) });
  assert.equal(second.startPort, first.port, `the second start must request the remembered port. Output:\n${second.output}`);
});

test('named break `remember-before-listen`/`false-ready`: a busy remembered port is replaced by the port really bound', { timeout: 180_000 }, async () => {
  const { repo, home } = await fixture('busy');
  const wanted = await sentinel();

  const first = await bootServe(repo, home, ['--port', String(wanted.port)]).finally(() => release(wanted.server));
  assert.ok(first.port);

  // Occupy the remembered port at the exact listen seam. No released number is re-acquired.
  const second = await bootServe(repo, home, [], { XEZ_TEST_BUSY_AT_BIND: String(first.port) });
  assert.equal(second.startPort, first.port, `the remembered port must be the resolved request. Output:\n${second.output}`);
  assert.notEqual(second.port, first.port, `a busy remembered port must not be the port serve reports. Output:\n${second.output}`);
  assert.match(second.output, new RegExp(`port ${first.port} was busy — using ${second.port}`));
  const [row] = await readRegistry(home);
  // The defect this names: remembering the port that was REQUESTED rather than the one the
  // listener reported. It survives a restart, so a wrong value here poisons every later start.
  assert.equal(
    row?.lastListen?.port,
    second.port,
    `the remembered port must be the one that was bound, not the one that was asked for. Registry: ${JSON.stringify(row)}`,
  );
});

test('named break `memory-over-flag`: an explicit --port beats the remembered port', { timeout: 180_000 }, async () => {
  const { repo, home } = await fixture('flag');
  const remembered = await sentinel();
  await bootServe(repo, home, ['--port', String(remembered.port)]).finally(() => release(remembered.server));

  const asked = await sentinel();
  const boot = await bootServe(repo, home, ['--port', String(asked.port)]).finally(() => release(asked.server));

  assert.equal(boot.startPort, asked.port, `--port must be the resolved request over memory. Output:\n${boot.output}`);
  assert.ok(boot.port);
  const [row] = await readRegistry(home);
  assert.equal(row?.lastListen?.port, boot.port, 'the newly bound port becomes the memory');
});

test('named break `env-over-stored`: a project port beats XEZ_PORT', { timeout: 180_000 }, async () => {
  const { repo, home } = await fixture('stored');
  // One boot to create the registry row, then pin a port on it the way `xez projects port` does.
  const seed = await sentinel();
  await bootServe(repo, home, ['--port', String(seed.port)]).finally(() => release(seed.server));
  const projects = await readRegistry(home);
  const chosen = await sentinel();
  const envPort = await sentinel();
  assert.notEqual(chosen.port, envPort.port);
  const configPath = join(home, 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as { projects: RegistryRow[] };
  assert.ok(projects[0]?.id, 'the boot must have registered the fixture');
  config.projects[0]!.cli = { port: chosen.port };
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

  const boot = await bootServe(repo, home, [], { XEZ_PORT: String(envPort.port) }).finally(async () => {
    await release(chosen.server);
    await release(envPort.server);
  });

  assert.equal(boot.startPort, chosen.port, `projects[].cli.port must be the resolved request over XEZ_PORT. Output:\n${boot.output}`);
  assert.ok(boot.port, `serve must report the port it actually bound. Output:\n${boot.output}`);
});

test('--port 0 binds an OS port and is never remembered', { timeout: 180_000 }, async () => {
  const { repo, home } = await fixture('ephemeral');

  const boot = await bootServe(repo, home, ['--port', '0']);

  assert.ok(boot.port && boot.port > 0, `--port 0 must bind a real port. Output:\n${boot.output}`);
  // "Any free port" is a request for anything. Remembering it would turn the next plain `xez`
  // into a start at a random high port (`open-questions.md` Q-4).
  const [row] = await readRegistry(home);
  assert.equal(row?.lastListen, undefined, `a --port 0 start must not be remembered. Registry: ${JSON.stringify(row)}`);
  assert.doesNotMatch(boot.output, /was busy/);
});

test('an invalid value is refused before anything is claimed', { timeout: 120_000 }, async () => {
  const { repo, home } = await fixture('invalid');

  const boot = await bootServe(repo, home, ['--port', '43a1']);

  assert.equal(boot.exitCode, 1, `a bad --port must exit 1. Output:\n${boot.output}`);
  assert.match(boot.output, /--port must be a whole number from 0 to 65535 — got “43a1”/);
  assert.equal(boot.port, undefined, 'a refused start must print no cockpit URL');
  // Nothing was claimed: no registry, and so no writer claim and no socket either.
  assert.deepEqual(await readRegistry(home), [], 'a refused start must not touch the registry');
});

test('an invalid XEZ_PORT is refused the same way', { timeout: 120_000 }, async () => {
  const { repo, home } = await fixture('invalid-env');

  const boot = await bootServe(repo, home, [], { XEZ_PORT: '99999' });

  assert.equal(boot.exitCode, 1, `a bad XEZ_PORT must exit 1. Output:\n${boot.output}`);
  assert.match(boot.output, /XEZ_PORT must be a whole number from 0 to 65535/);
  assert.deepEqual(await readRegistry(home), []);
});

test('named break `memory-required`: a mangled stored port warns once and the cockpit still starts', { timeout: 180_000 }, async () => {
  const { repo, home } = await fixture('mangled');
  const seed = await sentinel();
  const seeded = await bootServe(repo, home, ['--port', String(seed.port)]).finally(() => release(seed.server));
  assert.ok(seeded.port);
  const configPath = join(home, 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as { projects: RegistryRow[] };
  (config.projects[0] as Record<string, unknown>).cli = { port: 'abc' };
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

  const boot = await bootServe(repo, home, [], { XEZ_TEST_BUSY_AT_BIND: String(seeded.port) });

  assert.ok(boot.port, `a mangled stored value must never stop the cockpit. Output:\n${boot.output}`);
  assert.match(boot.output, /projects\[\]\.cli\.port is “abc” — ignored/);
  // Degraded to absent, so the remembered port took over.
  assert.equal(boot.startPort, seeded.port, `the remembered port must become the resolved request. Output:\n${boot.output}`);
});
