import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LineFramer, encodeFrame } from './ipc.ts';
import { SERVER_CAPABILITIES } from './protocol.ts';

// #86 acceptance, against the REAL CLI: `xez serve` and `xez mcp` as separate
// processes, exactly as a coding agent would meet them. `--import tsx` rather than
// the `tsx` binary, which opens its own IPC pipe under TMPDIR — past the socket
// length limit inside a xezar task worktree (D-01 § 9.5).
const TSX = import.meta.resolve('tsx');
const CLI = fileURLToPath(new URL('../index.ts', import.meta.url));
const children: ChildProcess[] = [];
const extraRepos: string[] = [];
let home: string;
let repo: string;

function fixtureRepo(): string {
  const dir = mkdtempSync('/tmp/xzr-');
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'fixture']);
  return dir;
}

beforeEach(() => {
  home = mkdtempSync('/tmp/xzc-'); // short: see bridge.test.ts
  repo = fixtureRepo();
});
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const dir of [home, repo, ...extraRepos.splice(0)]) rmSync(dir, { recursive: true, force: true });
});

function xez(args: string[], cwd: string): ChildProcess {
  const child = spawn(process.execPath, ['--import', TSX, CLI, ...args], {
    cwd,
    env: { ...process.env, XEZ_HOME: home, XEZ_DRY_RUN: '1', XEZ_SKILLS_AUTO_UPDATE: '0', XEZ_NO_BANNER: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

/** `serve` prints this only once its bind really succeeded (#238), with the port it holds. */
const COCKPIT_LINE = /cockpit → http:\/\/localhost:(\d+)/;

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * `xez serve` in `cwd`, reached on the port it actually bound. This used to probe a free port,
 * release it and pass it on, and then trust it (#295): under a busy machine another cockpit
 * walking up from its own busy port took that port first, `serve` correctly moved on, and the
 * test went on talking to the neighbour — green over the wrong process, or a reset or timeout
 * when the neighbour went away. Now the OS picks the port inside the bind (`--port 0`, unless a
 * test asks for one) and the health check proves the cockpit is this project's.
 */
async function serve({ port = 0, cwd = repo }: { port?: number; cwd?: string } = {}): Promise<{
  child: ChildProcess;
  base: string;
  stdout: () => string;
  stderr: () => string;
}> {
  const child = xez(['serve', '--no-open', '--port', String(port)], cwd);
  let out = '';
  let err = '';
  child.stdout!.on('data', (c) => (out += String(c)));
  child.stderr!.on('data', (c) => (err += String(c)));
  const bound = await until('the cockpit to bind', async () => COCKPIT_LINE.exec(out)?.[1]);
  const base = `http://127.0.0.1:${bound}`;
  const health = await until('the cockpit', async () => {
    const res = await fetch(`${base}/api/v1/health`);
    return res.ok ? ((await res.json()) as { repoRoot?: string }) : undefined;
  });
  expect(health.repoRoot, 'the cockpit on the bound port is the one this test started').toBe(realpathSync(cwd));
  return { child, base, stdout: () => out, stderr: () => err };
}

/** `xez mcp` in `cwd`, with a JSON-RPC client on its stdio. */
function mcp(cwd: string) {
  const child = xez(['mcp'], cwd);
  const lines: string[] = [];
  const messages: Array<Record<string, unknown>> = [];
  const framer = new LineFramer(
    (line) => {
      lines.push(line);
      messages.push(JSON.parse(line) as Record<string, unknown>);
    },
    () => {},
  );
  child.stdout!.on('data', (c: Buffer) => framer.push(c));
  let nextId = 0;
  const request = (method: string, params?: unknown) => {
    const id = nextId++;
    child.stdin!.write(encodeFrame({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }));
    return until(`${method} response`, async () => messages.find((m) => m.id === id), 10_000);
  };
  const initialize = (protocolVersion: string) =>
    request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'acceptance', version: '1' } });
  const exit = () =>
    new Promise<number | null>((resolve) => {
      child.once('exit', resolve);
      child.stdin!.end();
    });
  return { request, initialize, exit, lines };
}

const text = (m: Record<string, unknown>) => (m.result as { content: Array<{ text: string }> }).content[0]?.text ?? '';

describe('xez mcp against a real xezar (#86 acceptance)', () => {
  it('completes the MCP handshake against a running XEZ_DRY_RUN cockpit and reaches its project', async () => {
    await serve();
    const socket = await until('the MCP socket', async () => {
      const entries = (() => {
        try {
          return execFileSync('ls', [join(home, 'ipc')], { encoding: 'utf8' }).trim();
        } catch {
          return '';
        }
      })();
      return entries.endsWith('.sock') ? entries : undefined;
    });
    const registry = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { projects: Array<{ id: string }> };
    const projectId = registry.projects[0]?.id;
    expect(socket).toBe(`${projectId}.sock`);

    for (const version of ['2025-06-18', '2025-11-25']) {
      const client = mcp(repo);
      const init = await client.initialize(version);
      expect(init.result).toMatchObject({
        protocolVersion: version,
        capabilities: SERVER_CAPABILITIES,
        serverInfo: { name: 'xezar' },
      });
      expect((init.result as { capabilities: unknown }).capabilities).toEqual({ tools: { listChanged: false } });
      const health = await client.request('tools/call', { name: 'health', arguments: { projectId: 'someone-else' } });
      expect(health.result).toMatchObject({ structuredContent: { status: 'running', project: { id: projectId } } });
      expect(await client.exit()).toBe(0);
      // stdout carried JSON-RPC and nothing else.
      for (const line of client.lines) expect(() => JSON.parse(line)).not.toThrow();
    }
  }, 60_000);

  it('with the bridge entirely absent, `xez serve` still boots and the cockpit works', async () => {
    // Make the socket impossible: a plain file where the ipc directory would go.
    writeFileSync(join(home, 'ipc'), 'not a directory');
    const cockpit = await serve();
    const health = (await (await fetch(`${cockpit.base}/api/v1/health`)).json()) as { version?: string };
    expect(typeof health.version).toBe('string');
    expect((await fetch(`${cockpit.base}/`)).status).toBe(200);
    expect((await fetch(`${cockpit.base}/api/v1/runs`)).status).toBe(200);
    await until('the MCP warning', async () => (cockpit.stderr().includes('MCP bridge unavailable') ? true : undefined));
    expect(cockpit.stderr().match(/MCP bridge unavailable/g)).toHaveLength(1);
  }, 60_000);

  it('with the xezar service not running, the bridge still handshakes and fails readably instead of hanging', async () => {
    // Register the project the ordinary way, then stop the cockpit.
    const cockpit = await serve();
    await until('the MCP socket', async () => {
      try {
        return execFileSync('ls', [join(home, 'ipc')], { encoding: 'utf8' }).includes('.sock') ? true : undefined;
      } catch {
        return undefined;
      }
    });
    await new Promise((resolve) => {
      cockpit.child.once('exit', resolve);
      cockpit.child.kill('SIGTERM');
    });

    const client = mcp(repo);
    const started = Date.now();
    await client.initialize('2025-11-25');
    await client.request('tools/list');
    // D-09 B-12 (#206): initialize + tools/list answer without the service within 5 s.
    expect(Date.now() - started).toBeLessThan(5_000);
    const called = Date.now();
    const health = await client.request('tools/call', { name: 'health' });
    expect(Date.now() - called).toBeLessThan(2_000);
    expect(health.result).toMatchObject({ isError: true, structuredContent: { status: 'not-running' } });
    expect(text(health)).toMatch(/^xezar is not running for project .+\. Start the cockpit/);
    expect(await client.exit()).toBe(0);

    // A directory xezar has never served: same shape, a different reason.
    const stranger = join(home, 'elsewhere');
    mkdirSync(stranger);
    const outsider = mcp(stranger);
    await outsider.initialize('2025-06-18');
    const unknown = await outsider.request('tools/call', { name: 'health' });
    expect(unknown.result).toMatchObject({ isError: true, structuredContent: { status: 'not-registered' } });
    expect(await outsider.exit()).toBe(0);
  }, 60_000);

  it('reaches the cockpit it started even when another cockpit holds the port it asked for (#295)', async () => {
    // What the old probe-and-release race left behind, made certain: the port handed to `serve`
    // already answers as a neighbour's cockpit, so `serve` moves on and says so.
    const other = fixtureRepo();
    extraRepos.push(other);
    const neighbour = await serve({ cwd: other });
    const taken = Number(new URL(neighbour.base).port);
    const own = await serve({ port: taken });
    expect(own.base, 'the harness must not stop at the neighbour').not.toBe(neighbour.base);
    expect(own.stdout()).toContain(`port ${taken} was busy`);
  }, 60_000);
});
