import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const packageRoot = resolve(import.meta.dirname, '../..');
const entry = join(packageRoot, 'src', 'index.ts');

// The CLI entry is run from source through tsx (already a root devDependency and the
// loader this suite itself runs under), so the test needs no prior `npm run build`.
async function runCli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFile(process.execPath, ['--import', 'tsx', entry, ...args], {
    cwd,
    // XEZ_HOME is pinned so a regression that reaches the workspace registry can
    // never write into the developer's real ~/.xezar.
    env: { ...process.env, XEZ_HOME: join(cwd, 'xez-home') },
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function expectedVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

test('`--version` and `-v` print the bare package version and exit 0', { timeout: 120_000 }, async () => {
  const version = await expectedVersion();
  for (const flag of ['--version', '-v']) {
    const result = await runCli([flag], packageRoot);
    assert.equal(result.stdout, `${version}\n`, `${flag} must print exactly the version plus a newline`);
    assert.equal(result.stderr, '', `${flag} must print nothing to stderr`);
  }
});

test('`--version` works outside any git repository and touches no state', { timeout: 120_000 }, async () => {
  const version = await expectedVersion();
  // test-local-state.mjs puts GIT_CEILING_DIRECTORIES over tmpdir, so this directory is
  // genuinely outside a repository from git's point of view.
  const outside = await mkdtemp(join(tmpdir(), 'xezar-cli-version-'));
  try {
    const result = await runCli(['--version'], outside);
    assert.equal(result.stdout, `${version}\n`);
    await assert.rejects(
      readFile(join(outside, 'xez-home', 'config.json')),
      '--version must not create the workspace registry',
    );
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test('`--version` wins over a positional command, like `--help` does', { timeout: 120_000 }, async () => {
  const version = await expectedVersion();
  const result = await runCli(['run', 'a task that must never start', '--version'], packageRoot);
  assert.equal(result.stdout, `${version}\n`);
});

test('`--help` lists the version flag', { timeout: 120_000 }, async () => {
  const result = await runCli(['--help'], packageRoot);
  assert.match(result.stdout, /^ {2}-v, --version {15}print the version and exit$/m);
});
