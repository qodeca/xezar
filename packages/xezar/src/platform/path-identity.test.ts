import { describe, expect, it } from 'vitest';
import { containsPathSegments, isInsideByIdentity, isInsideDotGit, lookupSamePath, samePath } from './path-identity.ts';

const POSIX_PLATFORMS = ['linux', 'darwin'] as const;
const WORKTREES = ['.local', 'xezar', 'worktrees'] as const;

describe('path identity – POSIX pins (the old expressions, byte for byte)', () => {
  const pairs: Array<[string, string]> = [
    ['/a', '/a'],
    ['/A', '/a'],
    ['/a/', '/a'],
    ['/a/b', '/a'],
    ['/a', '/ab'],
    ['/', '/a'],
    ['C:\\x', 'c:\\x'],
    ['', ''],
  ];
  for (const platform of POSIX_PLATFORMS) {
    it(`samePath ≡ === and isInsideByIdentity ≡ startsWith(parent + '/') on ${platform}`, () => {
      for (const [a, b] of pairs) {
        expect(samePath(a, b, platform), `${a} ${b}`).toBe(a === b);
        expect(isInsideByIdentity(a, b, platform), `${a} ${b}`).toBe(b.startsWith(a + '/'));
        expect(isInsideByIdentity(b, a, platform), `${b} ${a}`).toBe(a.startsWith(b + '/'));
      }
    });
    it(`containsPathSegments ≡ the old includes on ${platform}`, () => {
      for (const path of [
        '/r/.local/xezar/worktrees/abc',
        '/r/.local/xezar/worktrees',
        '/r/.local/xezar/worktreesX/abc',
        '/r/.LOCAL/xezar/worktrees/abc',
        'C:\\r\\.local\\xezar\\worktrees\\abc',
        '',
      ]) {
        expect(containsPathSegments(path, WORKTREES, platform), path).toBe(
          `${path}/`.includes('/.local/xezar/worktrees/'),
        );
      }
    });
    it(`lookupSamePath is always undefined on ${platform}`, () => {
      expect(lookupSamePath([['/a', 1]], '/a', platform)).toBeUndefined();
      expect(lookupSamePath(new Map([['/A', 1]]), '/a', platform)).toBeUndefined();
    });
  }
});

describe('samePath – win32', () => {
  it.each([
    ['c:\\Repo', 'C:\\repo'],
    ['C:/x/y', 'C:\\x\\y'],
    ['C:\\x\\', 'C:\\x'],
    ['C:\\', 'c:\\'],
    ['\\\\SRV\\Share\\x', '\\\\srv\\share\\x'],
    ['//srv/share/x', '\\\\srv\\share\\x'],
  ])('%s ≡ %s', (a, b) => {
    expect(samePath(a, b, 'win32')).toBe(true);
    expect(samePath(b, a, 'win32')).toBe(true);
  });
  it.each([
    ['C:\\x', 'C:\\x\\y'],
    ['C:\\x', 'D:\\x'],
    ['C:\\foo', 'C:\\foobar'],
  ])('%s ≢ %s', (a, b) => {
    expect(samePath(a, b, 'win32')).toBe(false);
  });
});

describe('isInsideByIdentity – win32', () => {
  it('finds a child whatever the case or separators', () => {
    expect(isInsideByIdentity('C:\\Users\\Me', 'c:/users/me/.xezar', 'win32')).toBe(true);
    expect(isInsideByIdentity('C:\\Users\\Me\\', 'C:\\Users\\Me\\x', 'win32')).toBe(true);
  });
  it('handles a root parent', () => {
    expect(isInsideByIdentity('C:\\', 'c:\\x', 'win32')).toBe(true);
    expect(isInsideByIdentity('C:\\', 'D:\\x', 'win32')).toBe(false);
  });
  it('never treats a name prefix or the folder itself as inside', () => {
    expect(isInsideByIdentity('C:\\foo', 'C:\\foobar', 'win32')).toBe(false);
    expect(isInsideByIdentity('C:\\foo', 'c:\\FOO', 'win32')).toBe(false);
    expect(isInsideByIdentity('C:\\foo', 'C:\\foo\\', 'win32')).toBe(false);
  });
});

describe('containsPathSegments – win32', () => {
  it('matches any case and separator', () => {
    expect(containsPathSegments('C:\\r\\.local\\xezar\\worktrees\\abc', WORKTREES, 'win32')).toBe(true);
    expect(containsPathSegments('c:/r/.LOCAL/Xezar/worktrees/abc', WORKTREES, 'win32')).toBe(true);
    expect(containsPathSegments('C:\\r\\.local\\xezar\\worktrees', WORKTREES, 'win32')).toBe(true);
  });
  it('does not match a longer folder name', () => {
    expect(containsPathSegments('C:\\r\\.local\\xezar\\worktreesX\\abc', WORKTREES, 'win32')).toBe(false);
    expect(containsPathSegments('C:\\r\\x.local\\xezar\\worktrees\\abc', WORKTREES, 'win32')).toBe(false);
  });
});

describe('lookupSamePath – win32', () => {
  it('finds the first case variant', () => {
    const entries: Array<[string, number]> = [
      ['C:\\Other', 0],
      ['c:\\repo', 1],
      ['C:\\REPO', 2],
    ];
    expect(lookupSamePath(entries, 'C:\\Repo', 'win32')).toBe(1);
    expect(lookupSamePath(new Map(entries), 'C:/repo/', 'win32')).toBe(1);
    expect(lookupSamePath(entries, 'C:\\Missing', 'win32')).toBeUndefined();
  });
});

// The Linux and macOS runs of the identity call-site tests force the win32 branch onto POSIX-looking
// paths (`withPlatform` in test/helpers/platform.ts). These rows pin that the win32 rules treat such
// paths as they treat drive paths: case- and separator-insensitive, nothing else.
describe('win32 rules on POSIX-looking paths', () => {
  it('compares, contains and looks up without case', () => {
    expect(samePath('/tmp/Repo', '/TMP/repo', 'win32')).toBe(true);
    expect(samePath('/tmp/Repo', '/tmp/Repo2', 'win32')).toBe(false);
    expect(isInsideByIdentity('/home/u/.xezar', '/HOME/U/.XEZAR/config.json', 'win32')).toBe(true);
    expect(isInsideByIdentity('/home/u/.xezar', '/home/u/.xezar-other/config.json', 'win32')).toBe(false);
    expect(containsPathSegments('/r/.LOCAL/Xezar/Worktrees/abc', WORKTREES, 'win32')).toBe(true);
    expect(lookupSamePath([['/TMP/REPO', 1]], '/tmp/Repo', 'win32')).toBe(1);
  });
});

describe('isInsideDotGit', () => {
  it.each(['C:\\r\\.git', 'C:\\r\\.git\\config', 'c:\\R\\.GIT\\objects\\x', 'C:/r/.Git/config', 'C:\\r\\.git\\'])(
    'refuses %s under C:\\r on win32',
    (target) => {
      expect(isInsideDotGit(target, 'C:\\r', 'win32')).toBe(true);
    },
  );
  it.each(['C:\\r', 'C:\\r\\.github\\x', 'C:\\r\\.gitignore', 'C:\\r\\sub\\.git\\config', 'C:\\other\\.git'])(
    'leaves %s under C:\\r alone on win32',
    (target) => {
      expect(isInsideDotGit(target, 'C:\\r', 'win32')).toBe(false);
    },
  );
  it.each(POSIX_PLATFORMS)('is always false on %s, where the exact-spelling checks answer', (platform) => {
    expect(isInsideDotGit('/r/.git', '/r', platform)).toBe(false);
    expect(isInsideDotGit('/r/.git/config', '/r', platform)).toBe(false);
  });
});
