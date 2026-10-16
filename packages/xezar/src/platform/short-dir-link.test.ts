import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkDir, TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import {
  SOCKET_SAFE_DIR_BYTES,
  ensureShortDirLink,
  needsShortDirLink,
  removeShortDirLink,
  shortDirLinkPath,
} from './short-dir-link.ts';

/** #1065: Chrome's singleton socket goes 41 bytes below `TMPDIR`, and a Unix socket path holds
 *  at most 107 bytes plus the NUL on Linux. */
const CHROME_SOCKET_SUFFIX = '/com.google.Chrome.XXXXXX/SingletonSocket';
const LINUX_SUN_PATH = 108;

describe('needsShortDirLink (#1065)', () => {
  const deep = `/home/someone/Projects/a-fairly-long-project-name/.local/xezar/tmp/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`;

  it('asks for a link on Linux when Chrome’s socket below the folder would not fit', () => {
    expect(Buffer.byteLength(deep + CHROME_SOCKET_SUFFIX)).toBeGreaterThanOrEqual(LINUX_SUN_PATH);
    expect(needsShortDirLink(deep, 'linux')).toBe(true);
  });

  it('leaves a folder alone that has room for the socket', () => {
    expect(Buffer.byteLength('/tmp/xez-agent-tmpdir-abc/tmp/run-a' + CHROME_SOCKET_SUFFIX)).toBeLessThan(LINUX_SUN_PATH);
    expect(needsShortDirLink('/tmp/xez-agent-tmpdir-abc/tmp/run-a', 'linux')).toBe(false);
  });

  it('never asks on Windows or macOS', () => {
    expect(needsShortDirLink(deep, 'win32')).toBe(false);
    expect(needsShortDirLink(deep, 'darwin')).toBe(false);
  });

  it('keeps the budget below the Linux socket limit with Chrome’s suffix', () => {
    expect(SOCKET_SAFE_DIR_BYTES + Buffer.byteLength(CHROME_SOCKET_SUFFIX)).toBeLessThan(LINUX_SUN_PATH);
  });
});

describe('the short link itself (#1065)', () => {
  let root: string;
  let target: string;

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), 'xez-sdl-'));
    target = join(root, 'deep', 'a'.repeat(80), 'run');
    mkdirSync(target, { recursive: true });
  });

  afterEach(() => {
    removeShortDirLink(target, root);
    rmSync(root, TEST_DIR_RM_OPTIONS);
  });

  it('gives a shorter path whose files land in the real folder', () => {
    const link = ensureShortDirLink(target, root);
    expect(link).toBe(shortDirLinkPath(target, root));
    expect(Buffer.byteLength(link)).toBeLessThan(Buffer.byteLength(target));
    writeFileSync(join(link, 'note.txt'), 'via link');
    expect(readFileSync(join(target, 'note.txt'), 'utf8')).toBe('via link');
  });

  it('finds its own link again on a later turn', () => {
    const first = ensureShortDirLink(target, root);
    expect(ensureShortDirLink(target, root)).toBe(first);
  });

  it('keeps the long path when the name is taken by anything but its own link', () => {
    mkdirSync(shortDirLinkPath(target, root));
    expect(ensureShortDirLink(target, root)).toBe(target);
  });

  it('never trusts a link that leads somewhere else', () => {
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    linkDir(elsewhere, shortDirLinkPath(target, root));
    expect(ensureShortDirLink(target, root)).toBe(target);
    removeShortDirLink(target, root);
    expect(lstatSync(shortDirLinkPath(target, root)).isSymbolicLink(), 'a foreign link stays').toBe(true);
  });

  it('removes only the link, never the folder it leads to', () => {
    const link = ensureShortDirLink(target, root);
    writeFileSync(join(target, 'keep.txt'), 'x');
    removeShortDirLink(target, root);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('x');
  });

  it('removes a link whose folder is already gone', () => {
    const link = ensureShortDirLink(target, root);
    rmSync(target, TEST_DIR_RM_OPTIONS);
    removeShortDirLink(target, root);
    expect(() => lstatSync(link)).toThrow();
  });

  it('is a no-op when there is no link', () => {
    expect(() => removeShortDirLink(target, root)).not.toThrow();
  });
});
