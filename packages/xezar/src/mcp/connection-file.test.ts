import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectDataDir } from '../project-data-paths.ts';
import { registerProject } from '../workspace/projects.ts';
import { mcpConnectionDescriptorSchema, mcpConnectionPath } from './connection-file.ts';
import { startMcpService } from './index.ts';

/**
 * D-04's connection file (#262, A-01): the running service writes
 * `<root>/.local/xezar/mcp-connection.json` so nobody hand-authors connection data. Driven through
 * the real `startMcpService` over a registered project, as `xezar serve` starts it.
 */

const VERSION = '0.0.0-connection';
const saved = process.env.XEZ_HOME;
const dirs: string[] = [];
const closers: Array<() => void> = [];

// A short home under /tmp: the task TMPDIR is past the 104-byte socket limit on macOS (D-01 E5).
const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  dirs.push(dir);
  return dir;
};

beforeEach(() => {
  process.env.XEZ_HOME = tmp('xzc-');
});

afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.XEZ_HOME;
  else process.env.XEZ_HOME = saved;
});

async function project() {
  const root = tmp('xzcp-');
  execFileSync('git', ['init', '-q', root]);
  const { id } = await registerProject(root);
  return { root, id, dataDir: projectDataDir(root) };
}

async function start(projectId: string, warnings: string[], env: NodeJS.ProcessEnv = process.env) {
  const handle = await startMcpService({ projectId, version: VERSION, env, warn: (message) => warnings.push(message) });
  closers.push(() => handle.close());
  return handle;
}

const aboutTheFile = (warnings: string[]) => warnings.filter((w) => w.includes('connection file'));

describe('D-04: the running service writes the MCP connection file (A-01, #262)', () => {
  it('names this project, this process and the socket that really listens; mode 0600, ignored by git, no secret', async () => {
    const p = await project();
    const secret = `ghp_${'Z9y8X7w6V5u4T3s2R1q0'.repeat(2)}`;
    const warnings: string[] = [];
    const handle = await start(p.id, warnings, { ...process.env, GITHUB_TOKEN: secret });

    const path = mcpConnectionPath(p.dataDir);
    expect(path).toBe(join(p.root, '.local', 'xezar', 'mcp-connection.json'));
    expect(existsSync(path), 'written on start').toBe(true);
    expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
    const raw = readFileSync(path, 'utf8');
    // `.strict()`: the file carries D-04's labels and D-01's socket and nothing else — no token.
    const descriptor = mcpConnectionDescriptorSchema.strict().parse(JSON.parse(raw));
    expect(descriptor).toEqual({
      schemaVersion: 1,
      project: { id: p.id, root: p.root, dataDir: p.dataDir },
      service: { pid: process.pid, startedAt: expect.any(String) },
      endpoint: { socket: handle.path },
    });
    expect(Number.isNaN(Date.parse(descriptor.service.startedAt))).toBe(false);
    expect(existsSync(descriptor.endpoint.socket)).toBe(true);
    expect(raw).not.toContain(secret);
    expect(existsSync(`${path}.tmp`), 'the atomic-write sibling is gone').toBe(false);

    // Out of Git before it existed (D-04.4): both names are ignored and `git add -A` sees neither.
    const ignored = execFileSync('git', ['check-ignore', '.local/xezar/mcp-connection.json', '.local/xezar/mcp-connection.json.tmp'], {
      cwd: p.root,
      encoding: 'utf8',
    });
    expect(ignored.trim().split('\n')).toEqual(['.local/xezar/mcp-connection.json', '.local/xezar/mcp-connection.json.tmp']);
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: p.root, encoding: 'utf8' });
    expect(status).not.toContain('mcp-connection');
    expect(aboutTheFile(warnings)).toEqual([]);
  });

  it('overwrites what a previous service left, and rebuilds a deleted file on the next start', async () => {
    const p = await project();
    mkdirSync(p.dataDir, { recursive: true });
    const path = mcpConnectionPath(p.dataDir);
    writeFileSync(path, '{"schemaVersion":1,"service":{"pid":1},"token":"left-by-an-old-service"}\n', { mode: 0o644 });

    const first = await start(p.id, []);
    const written = mcpConnectionDescriptorSchema.strict().parse(JSON.parse(readFileSync(path, 'utf8')));
    expect(written.endpoint.socket).toBe(first.path);
    expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
    closers.pop()!(); // closes `first`

    unlinkSync(path);
    await start(p.id, []);
    expect(existsSync(path), 'rebuilt, never required').toBe(true);
  });

  it('N-07: a file that cannot be written is ONE warning, and the MCP socket still opens', async () => {
    const p = await project();
    // The atomic-write sibling is a directory, so the write fails the way a read-only folder does.
    mkdirSync(join(p.dataDir, 'mcp-connection.json.tmp'), { recursive: true });
    const warnings: string[] = [];
    const handle = await start(p.id, warnings);
    expect(existsSync(handle.path), 'the socket is open').toBe(true);
    expect(aboutTheFile(warnings)).toHaveLength(1);
    expect(aboutTheFile(warnings)[0]).toMatch(/MCP tools keep working without it/);
    expect(existsSync(mcpConnectionPath(p.dataDir))).toBe(false);
  });
});
