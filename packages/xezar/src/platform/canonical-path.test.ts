import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onWindows, TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import { resolvesInside } from '../mcp/tools/project-config.ts';
import { isInsideBrowseRoot, isLexicallyInsideBrowseRoot } from '../server/fs-browse.ts';
import { containmentSpelling } from './canonical-path.ts';

describe('containmentSpelling on Linux and macOS (#963)', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    it(`is resolve(path), case kept, on ${platform}`, async () => {
      for (const path of ['/Srv/Code/x', '/srv/code/../code/x', 'rel/x']) {
        expect(await containmentSpelling(path, platform)).toBe(resolve(path));
      }
    });
  }
});

/** The 8.3 short spelling of `path`, or null when the volume keeps none. */
function shortName(path: string): string | null {
  // Verbatim: Node's own quoting would put `\"` in front of cmd.exe, which reads it literally.
  const out = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${path}") do @echo %~sI"`], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
  }).stdout.trim();
  return out && !out.includes('"') && out.toLowerCase() !== path.toLowerCase() ? out : null;
}

// win32-skip(#976): letter case, 8.3 names and drive letters are Windows spellings; POSIX is pinned above
describe.skipIf(!onWindows)('containment on the Windows file system (#963)', () => {
  let base = '';
  let root = '';
  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'xez-contain-')));
    root = join(base, 'Root');
    mkdirSync(join(root, 'Long Folder Name'), { recursive: true });
    mkdirSync(join(base, 'Root2'));
  });
  afterEach(() => {
    rmSync(base, TEST_DIR_RM_OPTIONS);
  });

  it('allows the same folder spelled in another letter case', async () => {
    const other = join(base, 'ROOT', 'long folder name');
    expect(await isLexicallyInsideBrowseRoot(root, other)).toBe(true);
    expect(await isInsideBrowseRoot(root, other)).toBe(true);
    expect(resolvesInside(root, join(other, 'new.json'))).toBe(true);
    // The root in another case, too.
    expect(await isInsideBrowseRoot(root.toLowerCase(), join(root, 'Long Folder Name'))).toBe(true);
  });

  it('allows a missing folder spelled in another letter case, and answers the same as for one that exists', async () => {
    expect(await isLexicallyInsideBrowseRoot(root, join(base, 'root', 'not-there-yet'))).toBe(true);
    expect(await isLexicallyInsideBrowseRoot(root, join(base, 'root2', 'not-there-yet'))).toBe(false);
  });

  it('allows the 8.3 short spelling of a folder inside', async (ctx) => {
    const inside = join(root, 'Long Folder Name');
    const short = shortName(inside);
    if (short === null) ctx.skip(); // win32-skip(#976): this volume keeps no 8.3 names
    expect(await isLexicallyInsideBrowseRoot(root, short!)).toBe(true);
    expect(await isInsideBrowseRoot(root, short!)).toBe(true);
    expect(resolvesInside(root, join(short!, 'x.json'))).toBe(true);
  });

  it('refuses the look-alike sibling Root2, in any letter case', async () => {
    for (const path of [join(base, 'Root2'), join(base, 'root2'), join(base, 'ROOT2', 'x')]) {
      expect(await isLexicallyInsideBrowseRoot(root, path), path).toBe(false);
      expect(resolvesInside(root, path), path).toBe(false);
    }
    expect(await isInsideBrowseRoot(root, join(base, 'root2'))).toBe(false);
  });
});
