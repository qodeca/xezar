import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { linkDir, onWindows, TEST_DIR_RM_OPTIONS } from '../helpers/platform.ts';
/** migrate-local-state.mjs refuses to move legacy data it cannot prove idle, and proves it with lsof. */
const NO_LSOF = onWindows ? 'win32-skip(#963): migrate-local-state.mjs exits 1 "install lsof before migration"; Windows has no lsof' : false;
const repo = resolve(import.meta.dirname, '../../../..');
const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'xez-qa-migration-')); roots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true }); mkdirSync(join(root, '.ai/qa'), { recursive: true });
  copyFileSync(join(repo, 'scripts/migrate-local-state.mjs'), join(root, 'scripts/migrate-local-state.mjs'));
  copyFileSync(join(repo, 'scripts/test-env-up.sh'), join(root, 'scripts/test-env-up.sh'));
  return root;
}
function migrate(root: string) { return spawnSync(process.execPath, [join(root, 'scripts/migrate-local-state.mjs')], { encoding: 'utf8' }); }
afterEach(() => roots.splice(0).forEach(root => rmSync(root, TEST_DIR_RM_OPTIONS)));
test('preserves old QA bytes in an archive and is safe to run twice', { skip: NO_LSOF }, () => {
  const root = fixture();
  writeFileSync(join(root, '.ai/qa/test-env.json'), '{"status":"stopped"}\n');
  writeFileSync(join(root, '.ai/qa/secret-fixture'), 'private fixture');
  assert.equal(migrate(root).status, 0);
  assert.equal(readFileSync(join(root, '.local/legacy-qa/secret-fixture'), 'utf8'), 'private fixture');
  assert.equal(existsSync(join(root, '.local/legacy-qa/test-env.lock')), false);
  assert.equal(migrate(root).status, 0);
  assert.equal(existsSync(join(root, '.ai/qa')), false);
});
test('refuses active processes, corrupt descriptors and archives that already exist without touching source', () => {
  const root = fixture(); const file = join(root, '.ai/qa/test-env.json');
  writeFileSync(file, JSON.stringify({ app: { pid: process.pid }, status: 'running' }));
  assert.match(migrate(root).stderr, /process is alive/);
  // win32-skip(#963): spawn /bin/sh fails ENOENT (status null) on Windows; the migrate refusals below still run there.
  if (!onWindows) {
    const boot = spawnSync('/bin/sh', [join(root, 'scripts/test-env-up.sh')], { encoding: 'utf8' });
    assert.equal(boot.status, 1); assert.match(boot.stderr, /legacy QA state exists/);
  }
  writeFileSync(file, '{broken'); assert.match(migrate(root).stderr, /corrupt/);
  assert.equal(readFileSync(file, 'utf8'), '{broken');
  writeFileSync(file, '{}'); mkdirSync(join(root, '.local/legacy-qa'), { recursive: true });
  assert.match(migrate(root).stderr, /already exists/);
  assert.equal(existsSync(file), true);
});
test('runs as a CLI when invoked through a symlinked path', { skip: NO_LSOF }, () => {
  // macOS's temp dir is a symlink (/var/folders → /private/var/folders): Node reports the real
  // path in import.meta.url while argv[1] keeps the symlinked spelling, and a literal
  // comparison in the main-module guard skipped the whole CLI block (#27).
  const root = fixture(); const link = `${root}-link`; roots.push(link);
  linkDir(root, link);
  writeFileSync(join(root, '.ai/qa/test-env.json'), '{"status":"stopped"}\n');
  const result = spawnSync(process.execPath, [join(link, 'scripts/migrate-local-state.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Preserved legacy QA/);
  assert.equal(existsSync(join(root, '.local/legacy-qa/test-env.json')), true);
});
