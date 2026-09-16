import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const COCKPIT_LINE = /cockpit → http:\/\/localhost:(\d+)/;

/**
 * AC-01 of #467: two projects, one machine, one registry, at the same time.
 *
 * The BUILT CLI, from the release tarball, because this is exactly the claim a release makes:
 * "run xezar for different projects on a single computer" (the issue's own words). Two
 * cockpits share one isolated `XEZ_HOME`, each takes its own port, each answers `/api/v1/health`
 * naming its OWN boot project, each remembers its own port, and `xez mcp` in each repo reaches
 * that repo's bridge and no other.
 *
 * Named break `wrong-instance`: B's MCP reaches A, a health answer names the other project, or
 * the second listener cannot start at all.
 * Named break `lost-registry-row`: one cockpit's start drops the other's registry row.
 *
 * Every process is stopped by the PID this test started — never by pattern (#156).
 */

interface Cockpit {
  child: ChildProcess;
  port: number;
  output: string;
  stop: () => Promise<void>;
}

async function startCockpit(cliPath: string, repo: string, home: string): Promise<Cockpit> {
  const child = spawn(process.execPath, [cliPath, 'serve', '--no-open', '--repo', repo], {
    cwd: repo,
    env: {
      ...process.env,
      XEZ_DRY_RUN: '1',
      XEZ_HOME: home,
      XEZ_NO_BANNER: '1',
      XEZ_SKILLS_AUTO_UPDATE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { output: '' };
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { state.output += chunk; });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { state.output += chunk; });
  let exited = false;
  const done = once(child, 'exit').then(() => { exited = true; });

  const stop = async (): Promise<void> => {
    if (exited) return;
    child.kill('SIGTERM');
    const stopped = await Promise.race([done.then(() => true), sleep(10_000, false)]);
    if (!stopped) {
      child.kill('SIGKILL');
      await done;
    }
  };

  const deadline = Date.now() + 90_000;
  while (!COCKPIT_LINE.test(state.output) && !exited && Date.now() < deadline) await sleep(50);
  const printed = COCKPIT_LINE.exec(state.output);
  if (!printed) {
    await stop();
    assert.fail(`cockpit for ${repo} never printed its URL. Output:\n${state.output}`);
  }
  return { child, port: Number(printed[1]), output: state.output, stop };
}

/** One `xez mcp` request/response round trip over stdio, in this repo's directory. */
async function askMcp(
  cliPath: string,
  repo: string,
  home: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, [cliPath, 'mcp', '--repo', repo], {
    cwd: repo,
    env: { ...process.env, XEZ_DRY_RUN: '1', XEZ_HOME: home, XEZ_NO_BANNER: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });

  const send = (payload: unknown) => child.stdin?.write(`${JSON.stringify(payload)}\n`);
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'xez-coexistence-test', version: '0' },
    },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method, params });

  const deadline = Date.now() + 60_000;
  let answer: Record<string, unknown> | undefined;
  while (answer === undefined && Date.now() < deadline) {
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      // AC-13: the MCP's stdout is JSON-RPC and nothing else. A banner, a warning or an
      // activity line here would break every client that parses this stream.
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        child.kill('SIGKILL');
        assert.fail(`xez mcp wrote a non-JSON-RPC line to stdout: ${JSON.stringify(line)}`);
      }
      if (parsed.id === 2) answer = parsed;
    }
    if (answer === undefined) await sleep(100);
  }
  child.stdin?.end();
  child.kill('SIGTERM');
  assert.ok(answer, `xez mcp in ${repo} never answered ${method}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  return answer;
}

test('two projects run at once on one machine, each on its own port and its own MCP', { timeout: 600_000 }, async () => {
  // `/tmp` explicitly: a task worktree's own TMPDIR sits inside the repository, and a fixture
  // under `.local/xezar/worktrees/` is refused registration, so it could never get a row.
  const root = await mkdtemp(join(realpathSync('/tmp'), 'xez-coexist-'));
  const cockpits: Cockpit[] = [];
  try {
    const packDir = join(root, 'pack');
    await mkdir(packDir);
    const packed = await execFile(
      npm,
      ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir],
      { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
    );
    const record = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0];
    assert.ok(record, 'npm pack should describe the generated tarball');

    const consumerDir = join(root, 'consumer');
    await mkdir(consumerDir);
    await writeFile(join(consumerDir, 'package.json'), '{"private":true}\n', 'utf8');
    await execFile(
      npm,
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', join(packDir, record.filename)],
      { cwd: consumerDir, maxBuffer: 10 * 1024 * 1024 },
    );
    const cliPath = join(consumerDir, 'node_modules', '@qodeca', 'xezar', 'dist', 'index.js');

    // ONE shared registry home for both projects — the coexistence the issue asks for is two
    // cockpits for one user, not two isolated installs.
    const home = join(root, 'home');
    const alpha = join(root, 'alpha');
    const beta = join(root, 'beta');
    for (const repo of [alpha, beta]) {
      await mkdir(repo);
      await execFile('git', ['init', '--initial-branch=main'], { cwd: repo });
      await writeFile(join(repo, 'README.md'), `# ${repo}\n`, 'utf8');
    }

    const first = await startCockpit(cliPath, alpha, home);
    cockpits.push(first);
    const second = await startCockpit(cliPath, beta, home);
    cockpits.push(second);

    // Named break `wrong-instance`: a second listener that cannot start, or one that lands on
    // the port the first holds.
    assert.notEqual(second.port, first.port, 'two cockpits must not claim one port');

    // Each answers for ITS OWN boot project.
    const health = async (port: number) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(res.status, 200);
      return (await res.json()) as { bootProject?: { id?: string; name?: string } | string };
    };
    const alphaHealth = await health(first.port);
    const betaHealth = await health(second.port);
    const nameOf = (body: { bootProject?: { id?: string; name?: string } | string }): string =>
      typeof body.bootProject === 'string' ? body.bootProject : (body.bootProject?.id ?? '');
    assert.match(nameOf(alphaHealth), /^alpha/, `the alpha cockpit must name alpha: ${JSON.stringify(alphaHealth.bootProject)}`);
    assert.match(nameOf(betaHealth), /^beta/, `the beta cockpit must name beta: ${JSON.stringify(betaHealth.bootProject)}`);

    // Named break `lost-registry-row`: two starts sharing one registry keep both rows, and
    // each row remembers its own port.
    const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as {
      projects: Array<{ id: string; root: string; lastListen?: { port?: number } }>;
    };
    const rows = new Map(config.projects.map((p) => [p.id, p]));
    assert.equal(rows.size, 2, `both projects must survive in the registry: ${JSON.stringify(config.projects)}`);
    const alphaRow = config.projects.find((p) => p.root.endsWith('/alpha'));
    const betaRow = config.projects.find((p) => p.root.endsWith('/beta'));
    assert.equal(alphaRow?.lastListen?.port, first.port);
    assert.equal(betaRow?.lastListen?.port, second.port);

    // Named break `wrong-instance`: each MCP bridge reaches its own project's socket. The
    // socket is named by project id, so a bridge that crossed over would answer with the
    // other project here.
    const alphaMcp = await askMcp(cliPath, alpha, home, 'tools/call', {
      name: 'discover_project',
      arguments: {},
    });
    const betaMcp = await askMcp(cliPath, beta, home, 'tools/call', {
      name: 'discover_project',
      arguments: {},
    });
    const boundProject = (answer: Record<string, unknown>, label: string): string => {
      const result = answer.result as { isError?: boolean; content?: Array<{ text?: string }> };
      const text = JSON.stringify(result?.content ?? answer);
      assert.ok(answer.error === undefined, `${label} MCP answered with an error: ${JSON.stringify(answer.error)}`);
      assert.notEqual(result?.isError, true, `${label} MCP answered with a tool error: ${text}`);
      // The tool's own first line. Anchoring on it means a "not registered" or "not running"
      // message — which would also contain the repo name — can never be read as a pass.
      const bound = /Bound to xezar project "([^"]+)" \(id ([^)]+)\)/.exec(
        result?.content?.map((c) => c.text ?? '').join('\n') ?? '',
      );
      assert.ok(bound, `${label} MCP did not name its bound project: ${text}`);
      return `${bound[1]}/${bound[2]}`;
    };
    const alphaBound = boundProject(alphaMcp, 'alpha');
    const betaBound = boundProject(betaMcp, 'beta');
    assert.match(alphaBound, /alpha/, `alpha's MCP must be bound to alpha, got ${alphaBound}`);
    assert.doesNotMatch(alphaBound, /beta/, `alpha's MCP must not reach beta, got ${alphaBound}`);
    assert.match(betaBound, /beta/, `beta's MCP must be bound to beta, got ${betaBound}`);
    assert.doesNotMatch(betaBound, /alpha/, `beta's MCP must not reach alpha, got ${betaBound}`);
  } finally {
    for (const cockpit of cockpits) await cockpit.stop();
    await rm(root, { recursive: true, force: true });
  }
});
