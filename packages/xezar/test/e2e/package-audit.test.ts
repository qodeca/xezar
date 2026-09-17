import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
 * #306 part 2 — every valid command-line subcommand, from the PACKED tarball, writes exactly one
 * `cli` audit record (spec `docs/features/mcp-server/audit-trail-origins-2026-09-17.md` § 5 and
 * § 11 "Packaged command line"). `--help`, `--version`, an unknown command and an unknown
 * `projects` word write none. Named break `B-CLI-PROJECTS-TAG`: drop `tag` from
 * `PROJECTS_SUBCOMMANDS` and the `projects tag` row below fails.
 */

interface AuditLine {
  origin: string;
  actor: { type: string; command?: string };
  action: string;
  outcome: { status: string; reason?: string };
  projectId: string;
}

const auditOf = async (repo: string): Promise<AuditLine[]> => {
  const path = join(repo, '.local', 'xezar', 'audit.ndjson');
  if (!existsSync(path)) return [];
  return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as AuditLine);
};

async function waitFor<T>(probe: () => Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

async function gitRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await execFile('git', ['init', '--initial-branch=main'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), '# audit fixture\n', 'utf8');
  await execFile('git', ['add', 'README.md'], { cwd: dir });
  await execFile('git', ['-c', 'user.name=Xezar CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'fixture'], { cwd: dir });
}

test('every command-line subcommand of the packed CLI writes one cli audit record', { timeout: 300_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xezar-package-audit-'));
  const children: Array<ReturnType<typeof spawn>> = [];
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
    const cli = join(consumer, 'node_modules', '@qodeca', 'xezar', 'dist', 'index.js');

    const repo = join(root, 'repo');
    const other = join(root, 'other');
    await gitRepo(repo);
    await gitRepo(other);
    // Children never inherit this task's handoff/todo/task identity, and every write stays in the sandbox.
    const { XEZ_HANDOFF_FILE: _h, XEZ_TODOS_FILE: _t, XEZ_TASK_ID: _i, ...inherited } = process.env;
    const env = { ...inherited, XEZ_DRY_RUN: '1', XEZ_HOME: join(root, 'xez-home'), XEZ_NO_BANNER: '1', XEZ_SKILLS_AUTO_UPDATE: '0' };
    const exec = (args: string[], ok = true) => {
      const pending = execFile(process.execPath, [cli, ...args], { cwd: consumer, env, timeout: 90_000, maxBuffer: 10 * 1024 * 1024 });
      return ok ? pending : pending.catch((err: unknown) => err);
    };
    const added = async (before: number, where = repo) => (await auditOf(where)).slice(before);

    // `run` registers the repo and creates its data folder; every later row appends to it.
    await exec(['run', 'mock:done', '--repo', repo]);
    let seen = 0;
    const expectRows = async (rows: Array<[string, string, string?]>, where = repo) => {
      const lines = await added(where === repo ? seen : 0, where);
      assert.deepEqual(
        lines.map((line) => [line.action, line.outcome.status, ...(line.outcome.reason ? [line.outcome.reason] : [])]),
        rows.map(([action, status, reason]) => [action, status, ...(reason ? [reason] : [])]),
      );
      for (const line of lines) {
        assert.equal(line.origin, 'cli');
        assert.equal(line.actor.type, 'cli');
      }
      if (where === repo) seen += lines.length;
    };
    await expectRows([['cli.run', 'applied']]);

    await exec(['run', '--repo', repo], false);
    await expectRows([['cli.run', 'refused', 'missing_task']]);

    await exec(['init', '--repo', repo]);
    await expectRows([['cli.init', 'applied']]);

    // Exclusions: flags that return before resolution, an unknown command, an unknown projects word.
    await exec(['--help']);
    await exec(['--version']);
    await exec(['no-such-command', '--repo', repo], false);
    await exec(['projects', 'no-such-word', '--repo', repo], false);
    await expectRows([]);

    await exec(['projects', '--repo', repo]);
    await exec(['projects', 'list', '--repo', repo]);
    await expectRows([
      ['cli.projects.list', 'applied'],
      ['cli.projects.list', 'applied'],
    ]);

    await exec(['projects', 'add', other, '--repo', repo]);
    const registry = JSON.parse(await readFile(join(root, 'xez-home', 'config.json'), 'utf8')) as { projects: Array<{ id: string; root: string }> };
    const otherId = registry.projects.find((project) => project.root.endsWith('/other'))?.id;
    assert.ok(otherId, 'projects add registered the second repo');
    await exec(['projects', 'tag', otherId, 'alpha', '--repo', repo]);
    await exec(['projects', 'port', otherId, '4999', '--repo', repo]);
    await exec(['projects', 'rm', otherId, '--repo', repo]);
    await exec(['projects', 'remove', 'no-such-project', '--repo', repo], false);
    await expectRows(
      [
        ['cli.projects.add', 'applied'],
        ['cli.projects.tag', 'applied'],
        ['cli.projects.port', 'applied'],
        ['cli.projects.remove', 'applied'],
      ],
      other,
    );
    await expectRows([['cli.projects.remove', 'refused', 'unknown_project']]);

    // server-install / deploy / uninstall: XEZ_DRY_RUN performs no real system change.
    await exec(['server-install', '--platform', 'ubuntu-vps', '--yes', '--repo', repo]);
    await exec(['server-deploy', '--platform', 'ubuntu-vps', '--yes', '--repo', repo]);
    // Registered projects make uninstall ask first; the non-interactive answer is "no": refused, `cancelled`.
    await exec(['server-uninstall', '--platform', 'ubuntu-vps', '--yes', '--repo', repo]);
    await exec(['server-deploy', '--platform', 'no-such-platform', '--repo', repo], false);
    await expectRows([
      ['cli.serverInstall', 'applied'],
      ['cli.serverDeploy', 'applied'],
      ['cli.serverUninstall', 'refused', 'cancelled'],
      ['cli.serverDeploy', 'refused', 'unknown_platform'],
    ]);
    // With no project registered there is nothing to confirm, and the uninstall plan begins.
    await execFile(process.execPath, [cli, 'server-uninstall', '--platform', 'ubuntu-vps', '--yes', '--repo', repo], {
      cwd: consumer,
      env: { ...env, XEZ_HOME: join(root, 'empty-home') },
      timeout: 90_000,
    });
    await expectRows([['cli.serverUninstall', 'applied']]);

    // mcp: with no cockpit running, the bridge's session is refused — recorded once, as refused.
    const bridge = spawn(process.execPath, [cli, 'mcp', '--repo', repo], { cwd: consumer, env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(bridge);
    bridge.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'audit-e2e', version: '1' } } })}\n`,
    );
    await waitFor(async () => ((await added(seen)).length > 0 ? true : undefined), 30_000, 'the cli.mcp record');
    bridge.stdin.end();
    const [mcpLine] = await added(seen);
    assert.equal(mcpLine?.action, 'cli.mcp');
    assert.equal(mcpLine?.outcome.status, 'refused');
    seen += 1;

    // serve: recorded once the server owns its listening socket.
    const serve = spawn(process.execPath, [cli, 'serve', '--no-open', '--port', '0', '--repo', repo], { cwd: consumer, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(serve);
    await waitFor(async () => ((await added(seen)).length > 0 ? true : undefined), 60_000, 'the cli.serve record');
    await expectRows([['cli.serve', 'applied']]);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
