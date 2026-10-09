import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FILE_SYMLINKS, linkDir, npmCommand, onWindows, shortTmpRoot, TEST_DIR_RM_OPTIONS, withPlatform } from '../helpers/platform.ts';

// POSIX identity: these pass both before and after #963 by design – they pin that adopting the
// helpers changes nothing on Linux or macOS.
test('POSIX: every helper returns the pre-#963 literal', { skip: onWindows ? 'win32-skip(#963): POSIX-only identity pin – the Windows branch is pinned by the next test' : false }, () => {
  assert.equal(onWindows, false);
  assert.equal(shortTmpRoot(), '/tmp');
  assert.equal(FILE_SYMLINKS, true);
  const c = npmCommand(['x']);
  assert.deepEqual(c, { file: 'npm', args: ['x'] });
  assert.equal(Object.hasOwn(c, 'shell'), false);
  assert.deepEqual(TEST_DIR_RM_OPTIONS, { recursive: true, force: true });
});

test('win32: temp root is tmpdir() and npm runs through node', { skip: onWindows ? false : 'Windows-only branch' }, () => {
  assert.equal(shortTmpRoot(), tmpdir());
  assert.equal(typeof FILE_SYMLINKS, 'boolean');
  const c = npmCommand(['x']);
  assert.equal(c.file, process.execPath);
  assert.equal(c.args.at(-1), 'x');
  assert.match(c.args[0] ?? '', /npm-cli\.js$/);
  assert.equal(Object.hasOwn(c, 'shell'), false);
  assert.deepEqual(TEST_DIR_RM_OPTIONS, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('win32 CI: file symlinks are available, so no FILE_SYMLINKS-gated suite is silently skipped', { skip: onWindows && process.env.CI ? false : 'Windows CI only' }, () => {
  // GitHub's Windows runners run elevated; a false here means every FILE_SYMLINKS-gated suite
  // skipped on CI without anyone seeing it.
  assert.equal(FILE_SYMLINKS, true);
});

test('npmCommand copies its arguments instead of aliasing them', () => {
  const input = ['pack', '--dry-run'] as const;
  const c = npmCommand(input);
  assert.notEqual(c.args, input);
  assert.deepEqual(c.args.slice(-2), ['pack', '--dry-run']);
});

test('linkDir: a relative target resolves against the link parent, and deleting that parent spares the target', () => {
  const root = mkdtempSync(join(tmpdir(), 'xez-linkdir-'));
  try {
    mkdirSync(join(root, 't'));
    writeFileSync(join(root, 't', 'marker.txt'), 'kept');
    mkdirSync(join(root, 'a'));
    linkDir('../t', join(root, 'a', 'link'));
    assert.equal(readFileSync(join(root, 'a', 'link', 'marker.txt'), 'utf8'), 'kept');
    rmSync(join(root, 'a'), TEST_DIR_RM_OPTIONS);
    assert.equal(existsSync(join(root, 'a')), false);
    assert.equal(readFileSync(join(root, 't', 'marker.txt'), 'utf8'), 'kept');
  } finally {
    rmSync(root, TEST_DIR_RM_OPTIONS);
  }
});

test('linkDir: an existing link path is an error, not a silent overwrite', () => {
  const root = mkdtempSync(join(tmpdir(), 'xez-linkdir-'));
  try {
    mkdirSync(join(root, 't'));
    mkdirSync(join(root, 'link'));
    assert.throws(() => linkDir(join(root, 't'), join(root, 'link')), { code: 'EEXIST' });
  } finally {
    rmSync(root, TEST_DIR_RM_OPTIONS);
  }
});

test('withPlatform reports the given platform inside and restores the real one, also after a throw', async () => {
  const real = process.platform;
  const other: NodeJS.Platform = real === 'win32' ? 'linux' : 'win32';
  assert.equal(await withPlatform(other, () => process.platform), other);
  assert.equal(process.platform, real);
  await assert.rejects(withPlatform(other, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(process.platform, real);
  assert.deepEqual(Object.getOwnPropertyDescriptor(process, 'platform'), { value: real, writable: false, enumerable: true, configurable: true });
});
