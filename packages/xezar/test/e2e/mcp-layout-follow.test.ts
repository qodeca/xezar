import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * #819 item 5 — the order of starting the MCP client and the cockpit no longer matters.
 *
 * Through the RELEASE TARBALL, the way a client really runs it: `xezar mcp` is spawned in a fresh
 * repository first (no `.xezar/workspace.json`, so it boots in the global layout), THEN the person
 * starts `xezar --single-project` in the same folder, and the SAME bridge process — no `/mcp`
 * reconnect, no restart — reaches that engine on a later call. Before the fix the bridge kept
 * looking in the global registry for its whole life and answered "not a xezar project yet" forever.
 *
 * Controlled backends only: XEZ_DRY_RUN=1, an isolated XEZ_HOME, the skill updater off. Every
 * process is stopped by its SAVED handle, never by a command-line pattern.
 */

interface Bridge {
  health(): Promise<{ isError?: boolean; text: string }>;
  stderr(): string;
  close(): Promise<void>;
}

function spawnBridge(cliPath: string, repo: string, env: NodeJS.ProcessEnv): Bridge {
  const child: ChildProcess = spawn(process.execPath, [cliPath, 'mcp'], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const answers = new Map<number, { result?: { content?: Array<{ text: string }>; isError?: boolean } }>();
  let buffer = '';
  let stderr = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as { id?: number; result?: never };
      if (typeof message.id === 'number') answers.set(message.id, message);
    }
  });
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const send = (message: unknown) => child.stdin!.write(`${JSON.stringify(message)}\n`);
  const answer = async (id: number) => {
    const deadline = Date.now() + 30_000;
    while (!answers.has(id)) {
      if (child.exitCode !== null) assert.fail(`the bridge exited (${child.exitCode}) before answering ${id}:\n${stderr}`);
      if (Date.now() > deadline) assert.fail(`the bridge never answered request ${id}:\n${stderr}`);
      await sleep(50);
    }
    return answers.get(id)!;
  };
  let next = 1;
  const ready = (async () => {
    const id = next++;
    send({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'layout-follow-e2e', version: '0' } } });
    assert.ok((await answer(id)).result, 'the bridge completes the handshake');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  })();
  return {
    async health() {
      await ready;
      const id = next++;
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'health', arguments: {} } });
      const reply = await answer(id);
      assert.ok(reply.result, `the health call was answered: ${JSON.stringify(reply)}`);
      return { isError: reply.result.isError, text: (reply.result.content ?? []).map((block) => block.text).join('\n') };
    },
    stderr: () => stderr,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const ended = once(child, 'exit');
      child.stdin!.end();
      await Promise.race([ended, sleep(5_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await ended;
      }
    },
  };
}

test('a client session started before the single-project engine reaches it with no reconnect (#819 item 5)', { timeout: 300_000 }, async () => {
  // Short paths under /tmp: in single-project mode the socket lives INSIDE the project
  // (`<project>/.local/xezar/ipc`), and a Unix socket path has a ~104-byte limit.
  const root = await mkdtemp(join(realpathSync('/tmp'), 'xez-lf-'));
  const home = join(root, 'home');
  let bridge: Bridge | undefined;
  let cockpit: ChildProcess | undefined;
  let cockpitOut = '';
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

    const repo = join(root, 'p');
    await mkdir(repo);
    await mkdir(home);
    await execFile('git', ['init', '--initial-branch=main'], { cwd: repo });
    await writeFile(join(repo, 'README.md'), '# layout-follow fixture\n', 'utf8');
    await execFile('git', ['add', 'README.md'], { cwd: repo });
    await execFile('git', ['-c', 'user.name=Xezar CI', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], { cwd: repo });

    const env: NodeJS.ProcessEnv = { ...process.env, XEZ_DRY_RUN: '1', XEZ_HOME: home, XEZ_NO_BANNER: '1', XEZ_SKILLS_AUTO_UPDATE: '0' };
    delete env.XEZ_REMOTE;
    delete env.XEZ_GLOBAL_LAYOUT;

    // 1. The client session first: the folder has no state yet, and the bridge says so.
    bridge = spawnBridge(cliPath, repo, env);
    const before = await bridge.health();
    assert.equal(before.isError, true, `before the engine the call is refused: ${before.text}`);

    // 2. Then the engine, in single-project mode, in the same folder.
    cockpit = spawn(process.execPath, [cliPath, '--single-project', '--port', '0', '--no-open', '--repo', repo], {
      cwd: repo,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cockpit.stdout!.on('data', (chunk: Buffer) => (cockpitOut += chunk.toString()));
    cockpit.stderr!.on('data', (chunk: Buffer) => (cockpitOut += chunk.toString()));

    // 3. The SAME bridge reaches it. The socket opens in the background after the server listens
    //    (N-07), so the call is repeated for a bounded while — each repeat is an ordinary call on
    //    the one live bridge process, never a reconnect.
    let after: { isError?: boolean; text: string } | undefined;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (cockpit.exitCode !== null) assert.fail(`the cockpit exited (${cockpit.exitCode}):\n${cockpitOut}`);
      after = await bridge.health();
      if (!after.isError) break;
      await sleep(250);
    }
    assert.ok(after && !after.isError, `the bridge started first reaches the single-project engine: ${after?.text}\n${cockpitOut}\n${bridge.stderr()}`);
    assert.match(after.text, /is running for project/);
    assert.match(cockpitOut, /single-project mode/);
  } finally {
    await bridge?.close();
    if (cockpit && cockpit.exitCode === null && cockpit.signalCode === null) {
      const ended = once(cockpit, 'exit');
      cockpit.kill('SIGTERM');
      await Promise.race([ended, sleep(10_000)]);
      if (cockpit.exitCode === null && cockpit.signalCode === null) {
        cockpit.kill('SIGKILL');
        await once(cockpit, 'exit');
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});
