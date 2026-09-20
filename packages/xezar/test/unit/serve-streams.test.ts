import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * AC-09 and the AC-13 compatibility rows, through the REAL CLI (#467, PR 3).
 *
 * The unit suite beside the renderer proves what a line says and when it is drawn. Only a real
 * process can prove which STREAM it went to — and that is the promise scripts depend on:
 *
 * - `serve` keeps its stdout contract. The banner, the backend checks and the `cockpit → <url>`
 *   line are exactly the bytes they were; every new activity line is on stderr, so `xez | tee`
 *   and anything that parses the URL keep working (`activity-on-stdout` is the named break).
 * - Off a terminal there is no escape byte anywhere, and each event is one logfmt line
 *   (`ansi-in-pipe`).
 * - `--quiet` keeps the cockpit line and hides the rest of the banner, and never hides a
 *   warning or an error (`quiet-hides-failure`).
 * - `xez mcp` writes JSON-RPC to stdout and nothing else, under every new logging flag
 *   (`banner-in-mcp`), and `--version` still answers without a home (`version-needs-home`).
 *
 * The CLI runs from source through tsx, like `serve-port-memory.test.ts`, so no build is
 * needed. Every process is stopped by the PID this test started — never by pattern: a
 * `pkill -f` on anything lifted from a skill or a script matches every peer agent on this
 * machine (#156).
 */

const packageRoot = resolve(import.meta.dirname, '../..');
const entry = join(packageRoot, 'src', 'index.ts');
const tsxLoader = import.meta.resolve('tsx');
const COCKPIT_LINE = /cockpit → http:\/\/localhost:(\d+)/;
/** ESC, the 8-bit CSI and OSC introducers, and BEL — nothing may carry one off a terminal. */
const ANY_ESCAPE = /[\u001b\u009b\u009d\u0007]/;

// `/tmp` explicitly: a task worktree's own TMPDIR is INSIDE the repository, and
// `shouldRegisterProject` refuses to register anything under `.local/xezar/worktrees/`.
const fixtureRoot = await mkdtemp(join(realpathSync('/tmp'), 'xez-streams-'));
after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

async function makeRepo(name: string): Promise<string> {
  const repo = join(fixtureRoot, name);
  execFileSync('git', ['init', '-q', repo], { cwd: fixtureRoot });
  await writeFile(join(repo, 'README.md'), '# fixture\n');
  execFileSync('git', ['-c', 'user.email=t@e.x', '-c', 'user.name=T', 'add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@e.x', '-c', 'user.name=T', 'commit', '-qm', 'init'], { cwd: repo });
  return repo;
}

interface Boot {
  stdout: string;
  stderr: string;
  port: number | undefined;
}

interface OutputWait {
  promise: Promise<RegExpExecArray>;
  cancel(): void;
}

/** Resolve from the stream event that carries readiness; the timer is only a failure bound. */
function waitForOutput(
  streams: NodeJS.ReadableStream[],
  read: () => string,
  pattern: RegExp,
  description: string,
): OutputWait {
  let settled = false;
  let resolveMatch: (match: RegExpExecArray) => void;
  let rejectMatch: (error: Error) => void;
  const promise = new Promise<RegExpExecArray>((resolve, reject) => {
    resolveMatch = resolve;
    rejectMatch = reject;
  });
  const inspect = () => {
    const match = pattern.exec(read());
    if (!settled && match) {
      settled = true;
      cleanup();
      resolveMatch(match);
    }
  };
  const deadline = setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectMatch(new Error(`timed out waiting for ${description}`));
  }, 60_000);
  const cleanup = () => {
    clearTimeout(deadline);
    for (const stream of streams) stream.off('data', inspect);
  };
  for (const stream of streams) stream.on('data', inspect);
  inspect();
  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      cleanup();
    },
  };
}

/** Hold an OS-assigned port until the caller releases it. */
async function heldPort(): Promise<{ port: number; server: Server }> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { port, server };
}

/** Boot `serve` with the two streams kept APART, wait for the cockpit line, stop it. */
async function bootServe(
  repo: string,
  home: string,
  args: string[] = [],
  port = '0',
  waitForMcp = false,
): Promise<Boot> {
  const child = spawn(
    process.execPath,
    ['--import', tsxLoader, entry, 'serve', '--no-open', '--repo', repo, '--port', port, ...args],
    {
      cwd: repo,
      env: {
        ...process.env,
        XEZ_DRY_RUN: '1',
        XEZ_HOME: home,
        XEZ_NO_BANNER: '1',
        XEZ_SKILLS_AUTO_UPDATE: '0',
        CI: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const cockpitReady = waitForOutput(
    [child.stdout],
    () => stdout,
    COCKPIT_LINE,
    'serve cockpit readiness line',
  );
  const mcpReady = waitForMcp
    ? waitForOutput(
        [child.stderr],
        () => stderr,
        /event=mcp\.(?:ready|unavailable)\b/,
        'serve MCP ready or unavailable line',
      )
    : undefined;
  let exited = false;
  const done = once(child, 'exit').then(() => { exited = true; });
  const reap = () => { child.kill('SIGKILL'); };
  process.once('exit', reap);
  try {
    await Promise.all([cockpitReady.promise, ...(mcpReady ? [mcpReady.promise] : [])]);
    const printed = COCKPIT_LINE.exec(stdout);
    return { stdout, stderr, port: printed ? Number(printed[1]) : undefined };
  } finally {
    cockpitReady.cancel();
    mcpReady?.cancel();
    if (!exited) {
      child.kill('SIGTERM');
      await Promise.race([done, sleep(5_000)]);
      if (!exited) child.kill('SIGKILL');
    }
    process.off('exit', reap);
  }
}

test('serve keeps its stdout contract and puts every new activity line on stderr', async () => {
  // named break: `activity-on-stdout`
  const repo = await makeRepo('streams-default');
  const home = join(fixtureRoot, 'home-default');
  const boot = await bootServe(repo, home, [], '0', true);

  assert.match(boot.stdout, COCKPIT_LINE, 'the cockpit URL stays on stdout');
  assert.match(boot.stdout, /xezar v\d/, 'the banner stays on stdout');
  assert.match(boot.stdout, /branch /, 'the branch line stays on stdout');
  // Not one activity line reached stdout. `event=` is the plain form every one of them carries.
  assert.ok(!boot.stdout.includes('event='), `stdout carried an activity line:\n${boot.stdout}`);
  assert.match(boot.stderr, /event=mcp\.ready|event=mcp\.unavailable/, 'the MCP line is on stderr');
});

test('off a terminal there is no escape byte, and each event is one logfmt line', async () => {
  // named break: `ansi-in-pipe`
  const repo = await makeRepo('streams-plain');
  const home = join(fixtureRoot, 'home-plain');
  const boot = await bootServe(repo, home);

  assert.ok(!ANY_ESCAPE.test(boot.stderr), `stderr carried an escape byte:\n${JSON.stringify(boot.stderr)}`);
  assert.ok(!ANY_ESCAPE.test(boot.stdout), 'stdout carried an escape byte');
  for (const line of boot.stderr.split('\n').filter((l) => l.trim() !== '')) {
    assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z level=(debug|info|warn|error) /, `not a logfmt line: ${line}`);
    assert.match(line, / event=[a-z.]+/, `no event name: ${line}`);
  }
});

test('an explicit --output rich off a terminal falls back to plain, and says so once', async () => {
  const repo = await makeRepo('streams-fallback');
  const home = join(fixtureRoot, 'home-fallback');
  const boot = await bootServe(repo, home, ['--output', 'rich']);

  const fallbacks = boot.stderr.split('\n').filter((l) => l.includes('event=output.fallback'));
  assert.equal(fallbacks.length, 1, `expected exactly one fallback line, got ${fallbacks.length}`);
  assert.match(fallbacks[0] ?? '', /asked=rich using=plain/);
  assert.ok(!ANY_ESCAPE.test(boot.stderr), 'a refused rich must leave no escape byte behind');
});

test('--quiet keeps the cockpit line and drops the rest of the banner', async () => {
  // named break: `quiet-hides-failure` — the actual bound URL is never hidden.
  const repo = await makeRepo('streams-quiet');
  const home = join(fixtureRoot, 'home-quiet');
  const boot = await bootServe(repo, home, ['--quiet']);

  assert.match(boot.stdout, COCKPIT_LINE, 'quiet still prints the actual bound URL');
  assert.ok(!boot.stdout.includes('xezar v'), 'quiet drops the version banner');
  assert.ok(!boot.stderr.includes('level=info'), `quiet must print no info line:\n${boot.stderr}`);
});

test('--log-level debug adds the routine diagnostics, still only on stderr', async () => {
  const repo = await makeRepo('streams-debug');
  const home = join(fixtureRoot, 'home-debug');
  // BREAK-671-SERVE-PORT. The old test released a probed port, asked serve for it, then asserted
  // equality. A peer could take it first, and serve correctly fell back. Keep an OS-assigned
  // sentinel port occupied instead: fallback is now guaranteed, and the boot record is the source
  // of truth for what the app bound.
  const held = await heldPort();
  let boot: Boot;
  try {
    boot = await bootServe(repo, home, ['--log-level', 'debug'], String(held.port));
  } finally {
    await new Promise<void>((done) => held.server.close(() => done()));
  }

  assert.ok(boot.port && boot.port !== held.port, 'serve must report its fallback, not the occupied request');
  // Remembering this project's port is routine bookkeeping, so it is a debug line — visible
  // here and silent at the default level.
  assert.match(boot.stderr, /level=debug .* event=registry\.port/, `no debug line:\n${boot.stderr}`);
  assert.ok(!boot.stdout.includes('event='), 'they are still not on stdout');
});

test('the default level hides the routine diagnostics that debug shows', async () => {
  const repo = await makeRepo('streams-default-level');
  const home = join(fixtureRoot, 'home-default-level');
  const held = await heldPort();
  let boot: Boot;
  try {
    boot = await bootServe(repo, home, [], String(held.port));
  } finally {
    await new Promise<void>((done) => held.server.close(() => done()));
  }

  assert.ok(boot.port && boot.port !== held.port, 'serve must report its fallback, not the occupied request');
  assert.ok(!boot.stderr.includes('level=debug'), `default level printed a debug line:\n${boot.stderr}`);
});

test('xez mcp writes JSON-RPC to stdout and nothing else, under every new logging flag', async () => {
  // named break: `banner-in-mcp`
  const repo = await makeRepo('streams-mcp');
  const home = join(fixtureRoot, 'home-mcp');
  for (const args of [
    ['--log-level', 'debug'],
    ['--output', 'rich'],
    ['--color', 'always'],
    ['--quiet'],
  ]) {
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, entry, 'mcp', '--repo', repo, ...args],
      {
        cwd: repo,
        env: { ...process.env, XEZ_DRY_RUN: '1', XEZ_HOME: home, XEZ_NO_BANNER: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.resume();
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      })}\n`,
    );
    await sleep(2_500);
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), sleep(5_000)]);

    for (const line of stdout.split('\n').filter((l) => l.trim() !== '')) {
      // Every byte on this stream is protocol. A banner, a colour code or one stray log line
      // here is a broken MCP client, not an untidy terminal.
      const parsed: unknown = JSON.parse(line);
      assert.equal(
        (parsed as { jsonrpc?: string }).jsonrpc,
        '2.0',
        `not a JSON-RPC message under ${args.join(' ')}: ${line}`,
      );
    }
    assert.ok(!ANY_ESCAPE.test(stdout), `MCP stdout carried an escape byte under ${args.join(' ')}`);
  }
});

test('--version still answers without touching a home', async () => {
  // named break: `version-needs-home`
  const child = spawn(process.execPath, ['--import', tsxLoader, entry, '--version'], {
    cwd: fixtureRoot,
    env: { ...process.env, XEZ_HOME: join(fixtureRoot, 'does-not-exist') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  const [code] = (await once(child, 'exit')) as [number | null];
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
  assert.ok(!ANY_ESCAPE.test(stdout));
});
