import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * #117 — A-16's upgrade half (N-07, N-08, F-18, F-19): the RELEASE TARBALL, installed into an
 * isolated consumer, booted as the ordinary cockpit over a project whose state an older xezar left
 * behind, with the MCP state CORRUPT, then DELETED, across a hard restart, and with a second cockpit
 * trying to take the same project. The store-level half is `test/unit/mcp-durability.test.ts`.
 *
 * "Working cockpit" means all of: the health route answers, the cockpit page is served, the older
 * task is still listed, a new task can be created through the cockpit's own route, and the MCP
 * bridge a client would spawn (`xezar mcp`) reaches the service for this project. "No expanded
 * authority" means the request-origin guard still refuses a cross-origin write after the upgrade,
 * the MCP socket stays private to the user, and the second cockpit never becomes a second owner.
 *
 * Controlled backends only: XEZ_DRY_RUN=1, an isolated XEZ_HOME, no account, no secret, and the
 * default-on skill updater switched off so no `npx` runs. Every process is stopped by its SAVED
 * handle, never by a command-line pattern.
 */

const OLDER_RUN = '0b6f4c1e-7a51-4d2a-9f41-3c1b0d7e8a90';

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  server.close();
  await once(server, 'close');
  assert.ok(address && typeof address === 'object');
  return address.port;
}

interface Cockpit {
  child: ChildProcess;
  port: number;
  output(): string;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

function spawnCockpit(cliPath: string, repo: string, env: NodeJS.ProcessEnv, port: number): Cockpit {
  const child = spawn(process.execPath, [cliPath, '--port', String(port), '--no-open', '--repo', repo], {
    cwd: repo,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', (chunk: Buffer) => (out += chunk.toString()));
  child.stderr!.on('data', (chunk: Buffer) => (out += chunk.toString()));
  return {
    child,
    port,
    output: () => out,
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const ended = once(child, 'exit');
      child.kill(signal);
      await ended;
    },
  };
}

async function request(port: number, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

async function waitHealthy(cockpit: Cockpit, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cockpit.child.exitCode !== null) {
      assert.fail(`the cockpit exited (${cockpit.child.exitCode}) before it was healthy:\n${cockpit.output()}`);
    }
    try {
      if ((await request(cockpit.port, '/api/v1/health')).ok) return;
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  assert.fail(`the cockpit never became healthy:\n${cockpit.output()}`);
}

/** One MCP session the way a client runs it: spawn `xezar mcp` in the project, handshake, call `health`. */
async function bridgeHealth(cliPath: string, repo: string, env: NodeJS.ProcessEnv): Promise<{ isError?: boolean; text: string }> {
  const child = spawn(process.execPath, [cliPath, 'mcp'], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const answers = new Map<number, { result?: { content?: Array<{ text: string }>; isError?: boolean }; error?: unknown }>();
  let buffer = '';
  let stderr = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as { id?: number; result?: never; error?: unknown };
      if (typeof message.id === 'number') answers.set(message.id, message);
    }
  });
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const send = (message: unknown) => child.stdin!.write(`${JSON.stringify(message)}\n`);
  const answer = async (id: number) => {
    const deadline = Date.now() + 30_000;
    while (!answers.has(id)) {
      if (Date.now() > deadline) assert.fail(`the bridge never answered request ${id}:\n${stderr}`);
      await sleep(50);
    }
    return answers.get(id)!;
  };
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'upgrade-e2e', version: '0' } } });
    assert.ok((await answer(1)).result, 'the bridge completes the handshake');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'health', arguments: {} } });
    const health = await answer(2);
    assert.ok(health.result, `the health call was answered: ${JSON.stringify(health)}`);
    return { isError: health.result.isError, text: (health.result.content ?? []).map((block) => block.text).join('\n') };
  } finally {
    const ended = once(child, 'exit');
    child.stdin!.end();
    await Promise.race([ended, sleep(5_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await ended;
    }
  }
}

/** What an older xezar left in the project: a finished task whose record predates every MCP field. */
async function seedOlderProject(dataDir: string): Promise<void> {
  await mkdir(join(dataDir, 'runs'), { recursive: true });
  await writeFile(
    join(dataDir, 'runs.json'),
    JSON.stringify([
      {
        id: OLDER_RUN,
        title: 'a task from an older xezar',
        workflow: 'quick-task',
        task: 'older brief',
        status: 'done',
        createdAt: '2026-01-02T03:04:05.000Z',
        finishedAt: '2026-01-02T03:14:05.000Z',
        tokensUsed: 0,
        steps: [{ id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0 }],
      },
    ]),
    'utf8',
  );
}

/** Every MCP state file a project may hold, relative to its data directory. */
const MCP_STATE = [
  'mcp/event-journal.json',
  'mcp/event-journal.ndjson',
  'mcp/leader-cursors.json',
  'mcp/event-controller.json',
  'mcp-operations.ndjson',
  'mcp-operations.json',
  'mcp-audit.ndjson',
  'mcp-connection.json',
];

async function assertWorkingCockpit(cockpit: Cockpit, cliPath: string, repo: string, env: NodeJS.ProcessEnv, label: string): Promise<void> {
  const origin = `http://127.0.0.1:${cockpit.port}`;
  const health = await request(cockpit.port, '/api/v1/health');
  assert.equal(health.status, 200, `${label}: health answers`);

  const page = await request(cockpit.port, '/');
  assert.equal(page.status, 200, `${label}: the cockpit page is served`);
  assert.match(await page.text(), /<html/i);

  const runs = (await (await request(cockpit.port, '/api/v1/runs')).json()) as Array<{ id: string; title: string }>;
  assert.ok(runs.some((run) => run.id === OLDER_RUN && run.title === 'a task from an older xezar'), `${label}: the older task is retained`);

  const created = await request(cockpit.port, '/api/v1/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ task: `mock:done ${label}`, workflow: 'quick-task', worktree: false }),
  });
  assert.ok(created.status >= 200 && created.status < 300, `${label}: a new task is accepted (${created.status} ${await created.clone().text()})`);

  // No expanded authority: the request-origin guard still refuses a cross-origin write.
  const foreign = await request(cockpit.port, '/api/v1/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://attacker.example' },
    body: JSON.stringify({ task: 'mock:done from elsewhere', workflow: 'quick-task' }),
  });
  assert.equal(foreign.status, 403, `${label}: a cross-origin write is refused`);

  // The MCP half: the bridge a client spawns reaches THIS project's service. The socket opens in
  // the background after the server listens (N-07), so allow it a moment.
  let bridged: { isError?: boolean; text: string } | undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    bridged = await bridgeHealth(cliPath, repo, env);
    if (!bridged.isError) break;
    await sleep(250);
  }
  assert.ok(bridged && !bridged.isError, `${label}: the MCP bridge reaches the service (${bridged?.text})\n${cockpit.output()}`);
}

test('A-16: an upgraded cockpit stays usable with MCP state corrupt, deleted, after a hard restart, and never has two owners', { timeout: 300_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xezar-mcp-upgrade-'));
  // The socket lives under XEZ_HOME and a Unix socket path has a ~104-byte limit, which a task's
  // TMPDIR can exceed — so the home is short, under /tmp.
  const home = await mkdtemp(join(realpathSync('/tmp'), 'xez-up-'));
  const cockpits: Cockpit[] = [];
  try {
    const packDir = join(root, 'pack');
    await mkdir(packDir);
    const packed = await execFile(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir], {
      cwd: packageRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    const [record] = JSON.parse(packed.stdout) as Array<{ filename: string }>;
    assert.ok(record);
    const consumer = join(root, 'consumer');
    await mkdir(consumer);
    await writeFile(join(consumer, 'package.json'), '{"private":true}\n', 'utf8');
    await execFile(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', join(packDir, record.filename)], {
      cwd: consumer,
      maxBuffer: 10 * 1024 * 1024,
    });
    const cliPath = join(consumer, 'node_modules', '@qodeca', 'xezar', 'dist', 'index.js');

    const repo = join(root, 'project');
    await mkdir(repo);
    await execFile('git', ['init', '--initial-branch=main'], { cwd: repo });
    await writeFile(join(repo, 'README.md'), '# upgrade fixture\n', 'utf8');
    await execFile('git', ['add', 'README.md'], { cwd: repo });
    await execFile('git', ['-c', 'user.name=Xezar CI', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], { cwd: repo });
    const dataDir = join(repo, '.local', 'xezar');
    await seedOlderProject(dataDir);

    const env: NodeJS.ProcessEnv = { ...process.env, XEZ_DRY_RUN: '1', XEZ_HOME: home, XEZ_NO_BANNER: '1', XEZ_SKILLS_AUTO_UPDATE: '0' };
    delete env.XEZ_REMOTE;

    await t.test('MCP state corrupt, and a corrupt workspace config: the cockpit works and reports the config', async (t) => {
      await mkdir(join(dataDir, 'mcp'), { recursive: true });
      for (const file of MCP_STATE) await writeFile(join(dataDir, file), '{"left by": an older, broken xezar\n', 'utf8');
      await writeFile(join(home, 'config.json'), '{ not json', 'utf8');

      const cockpit = spawnCockpit(cliPath, repo, env, await freePort());
      cockpits.push(cockpit);
      try {
      await waitHealthy(cockpit);
      await assertWorkingCockpit(cockpit, cliPath, repo, env, 'corrupt MCP state');
      const configWarnings = cockpit.output().split('\n').filter((line) => /workspace config .* corrupt/.test(line));
      assert.ok(configWarnings.length >= 1, `the corrupt workspace config is reported:\n${cockpit.output()}`);
      // AGENTS.md § Workspace registry: ONE warning. Observed: two — a headless `xezar run` with no MCP
      // socket prints two as well, so this predates MCP. Kept as a TODO rather than weakened to ≥ 1.
      await t.test('FINDING: a corrupt workspace config is warned about exactly once', { todo: 'boot prints the corrupt-config warning twice (also without MCP); reported in the #117 PR' }, () => {
        assert.equal(configWarnings.length, 1, `exactly one warning for the corrupt workspace config:\n${configWarnings.join('\n')}`);
      });
      // Compatible data retained: MCP damage is never cleaned up by destroying it.
      for (const file of MCP_STATE) {
        assert.ok(existsSync(join(dataDir, file)) || existsSync(join(dataDir, `${file}.corrupt`)), `${file} is kept (in place or set aside)`);
      }

      } finally {
        // A hard restart: SIGKILL leaves the socket file and the writer claim of a dead process.
        await cockpit.stop('SIGKILL');
      }
    });

    await t.test('restart with MCP state deleted: the dead owner is reaped, the cockpit works, the socket stays private', async () => {
      for (const file of MCP_STATE) await rm(join(dataDir, file), { force: true });
      await rm(join(dataDir, 'mcp'), { recursive: true, force: true });
      // A config that parses and is simply empty is the user's own state: the snapshot must not
      // override it with a project the user removed.
      await writeFile(join(home, 'config.json'), '{}\n', 'utf8');
      await writeFile(
        join(home, 'config.json.bak'),
        JSON.stringify({ schemaVersion: 1, projects: [{ id: 'removed-by-user', root: join(root, 'gone'), name: 'removed' }] }),
        'utf8',
      );

      const cockpit = spawnCockpit(cliPath, repo, env, await freePort());
      cockpits.push(cockpit);
      await waitHealthy(cockpit);
      await assertWorkingCockpit(cockpit, cliPath, repo, env, 'deleted MCP state after a hard restart');
      const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as { projects?: Array<{ id: string }> };
      assert.equal(config.projects?.some((project) => project.id === 'removed-by-user'), false, 'an empty config is never overridden by its snapshot');

      const ipc = join(home, 'ipc');
      assert.equal(lstatSync(ipc).mode & 0o777, 0o700, 'the socket directory is private to the user');
      const sockets = readdirSync(ipc).filter((name) => name.endsWith('.sock'));
      assert.equal(sockets.length, 1, 'exactly one project socket after the restart');
      assert.equal(lstatSync(join(ipc, sockets[0]!)).mode & 0o777, 0o600, 'the socket is private to the user');

      // No two project owners: a second cockpit for the same project refuses, the first carries on.
      const second = spawnCockpit(cliPath, repo, env, await freePort());
      cockpits.push(second);
      const [code] = (await Promise.race([once(second.child, 'exit'), sleep(60_000).then(() => ['still running'])])) as [unknown];
      assert.notEqual(code, 0, `the second cockpit must not start as a second owner:\n${second.output()}`);
      assert.notEqual(code, 'still running', `the second cockpit must not start as a second owner:\n${second.output()}`);
      assert.match(second.output(), /already in use/);
      assert.equal((await request(cockpit.port, '/api/v1/health')).status, 200, 'the first cockpit is unaffected');
      const bridged = await bridgeHealth(cliPath, repo, env);
      assert.ok(!bridged.isError, `the MCP bridge still reaches the one owner: ${bridged.text}`);

      await cockpit.stop('SIGTERM');
    });
  } finally {
    for (const cockpit of cockpits) await cockpit.stop('SIGKILL').catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
