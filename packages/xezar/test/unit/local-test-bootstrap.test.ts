import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
const root = resolve(import.meta.dirname, '../../../..');
const bootstrap = resolve(root, 'scripts/test-local-state.mjs');
const marker = `${sep}.local${sep}xezar${sep}worktrees${sep}`;

/** Load `script` the way the npm scripts do and report the scratch root it pinned. */
function pinnedScratch(script: string, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync(process.execPath, [
    '--import', script, '--input-type=module', '-e',
    'import { tmpdir } from "node:os"; console.log(tmpdir());',
  ], { cwd: root, env, encoding: 'utf8' }).trim();
}

test('project-local temporary fixtures cannot discover or mutate their parent Git repository', () => {
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const result = JSON.parse(execFileSync(process.execPath, [
    '--import', bootstrap, '--input-type=module', '-e', `
      import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { execFileSync, spawnSync } from 'node:child_process';
      const fixture = mkdtempSync(join(tmpdir(), 'git-boundary-'));
      try {
        const absent = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: fixture });
        execFileSync('git', ['init', '-q'], { cwd: fixture });
        const present = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: fixture, encoding: 'utf8' }).trim();
        console.log(JSON.stringify({ scratch: tmpdir(), absent: absent.status, ownRepo: present === realpathSync(fixture) }));
      } finally { rmSync(fixture, { recursive: true, force: true }); }
    `,
  ], { cwd: root, encoding: 'utf8' }));
  // A checkout that is itself a xezar task worktree cannot keep scratch in-repo (see the next
  // test); every other checkout keeps the project-local root this document promises.
  const expected = `${root}${sep}`.includes(marker) ? result.scratch : resolve(root, '.local/test-tmp');
  assert.equal(result.scratch, expected);
  assert.ok(!`${result.scratch}${sep}`.includes(marker), 'scratch must never sit under a task-worktree ancestor');
  assert.notEqual(result.absent, 0, 'a non-repository fixture must not discover the parent checkout');
  assert.equal(result.ownRepo, true);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }), before);
});

// #19: the workspace registry refuses any project root under `.local/xezar/worktrees/`, so a
// checkout that IS a task worktree must pin scratch outside that ancestry or every temp repo the
// tests create is refused and the canonical gate cannot pass inside a xezar task.
test('a checkout that is itself a task worktree pins scratch outside the worktree ancestry', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'worktree-scratch-'));
  const created: string[] = [];
  try {
    const fakeRoot = join(fixture, '.local', 'xezar', 'worktrees', '0123456789ab');
    mkdirSync(join(fakeRoot, 'scripts'), { recursive: true });
    const script = join(fakeRoot, 'scripts', 'test-local-state.mjs');
    copyFileSync(bootstrap, script);

    const scratch = pinnedScratch(script);
    created.push(scratch);
    assert.ok(!scratch.startsWith(fakeRoot), `scratch ${scratch} must leave the worktree checkout`);
    assert.ok(!`${scratch}${sep}`.includes(marker), `scratch ${scratch} must not sit under a task-worktree ancestor`);
    assert.ok(!`${realpathSync(scratch)}${sep}`.includes(marker), 'nor may its realpath');
    assert.match(scratch, /[\\/]xezar-test-tmp-[0-9a-f]{12}$/, 'one hash-named directory per checkout');
    if (process.platform !== 'win32') assert.equal(statSync(scratch).mode & 0o777, 0o700);

    // A worker spawned with the moved TMPDIR reuses the directory instead of nesting one per level.
    const nested = pinnedScratch(script, { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch });
    assert.equal(nested, scratch);

    // A different worktree checkout never shares the directory.
    const otherRoot = join(fixture, '.local', 'xezar', 'worktrees', 'ba9876543210');
    mkdirSync(join(otherRoot, 'scripts'), { recursive: true });
    copyFileSync(bootstrap, join(otherRoot, 'scripts', 'test-local-state.mjs'));
    const other = pinnedScratch(join(otherRoot, 'scripts', 'test-local-state.mjs'));
    created.push(other);
    assert.notEqual(other, scratch);
  } finally {
    for (const dir of [fixture, ...created]) rmSync(dir, { recursive: true, force: true });
  }
});
