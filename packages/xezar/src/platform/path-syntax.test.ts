import { describe, expect, it } from 'vitest';
import {
  fromGitPath,
  isAbsolutePath,
  isDotGitSegment,
  isDrivePath,
  isFullyQualifiedPath,
  isWindowsNetworkSource,
  startsWithTildeSeparator,
} from './path-syntax.ts';

const POSIX_PLATFORMS = ['linux', 'darwin'] as const;

// Every spelling a call site used to test with `startsWith('/')`: the POSIX answers must be exactly
// that expression, whatever the host OS (#963 AC-1, AC-16).
const POSIX_PIN_TABLE = [
  '/',
  '/x',
  '//x',
  '',
  'x',
  './x',
  '~',
  '~/x',
  'C:\\x',
  'C:/x',
  '\\\\srv\\share\\x',
  '//srv/share/x',
  '\\x',
];

describe('isAbsolutePath / isFullyQualifiedPath – POSIX pins', () => {
  for (const platform of POSIX_PLATFORMS) {
    it(`equal startsWith('/') on ${platform}`, () => {
      for (const path of POSIX_PIN_TABLE) {
        expect(isAbsolutePath(path, platform), path).toBe(path.startsWith('/'));
        expect(isFullyQualifiedPath(path, platform), path).toBe(path.startsWith('/'));
      }
    });
  }
});

describe('isAbsolutePath – win32 (lenient READ rule)', () => {
  it.each(['C:\\x', 'C:/x', '\\\\srv\\share\\x', '//srv/share/x', '\\x', '/x', '\\\\.\\pipe\\x', '\\\\?\\C:\\x'])(
    'accepts %s',
    (path) => {
      expect(isAbsolutePath(path, 'win32')).toBe(true);
    },
  );
  it.each(['C:x', 'x\\y', '', '~'])('refuses %s', (path) => {
    expect(isAbsolutePath(path, 'win32')).toBe(false);
  });
});

describe('isFullyQualifiedPath – win32 (typed-folder rule)', () => {
  it.each(['C:\\x', 'C:/x', 'c:\\', '\\\\srv\\share\\x', '//srv/share/x', '\\\\srv\\share', '//srv/share', '\\\\srv.corp\\s'])(
    'accepts %s',
    (path) => {
      expect(isFullyQualifiedPath(path, 'win32')).toBe(true);
    },
  );
  // A UNC path must name a server AND a share; a parent step is not a server name.
  it.each(['\\\\srv', '\\\\srv\\', '//srv', '//srv/', '\\\\srv\\\\share', '\\\\..\\x', '\\\\..\\x\\y', '//../x', '\\\\.\\x'])(
    'refuses the incomplete or parent-step UNC form %s',
    (path) => {
      expect(isFullyQualifiedPath(path, 'win32')).toBe(false);
    },
  );
  // A share is a name, never a `.` or `..` step; a name that merely starts with a dot is one.
  it.each(['\\\\srv\\..', '\\\\srv\\.', '\\\\srv\\.\\x', '\\\\srv\\..\\x', '//srv/..', '//srv/./x'])(
    'refuses the step-in-the-share-place UNC form %s',
    (path) => {
      expect(isFullyQualifiedPath(path, 'win32')).toBe(false);
    },
  );
  it.each(['\\\\srv\\share', '\\\\srv\\.hidden', '\\\\srv\\..x\\y'])('accepts the share name in %s', (path) => {
    expect(isFullyQualifiedPath(path, 'win32')).toBe(true);
  });
  // The lenient READ rule keeps accepting them: only the typed-folder rule is strict.
  it.each(['\\\\srv', '\\\\..\\x'])('leaves isAbsolutePath lenient for %s', (path) => {
    expect(isAbsolutePath(path, 'win32')).toBe(true);
  });
  it.each([
    'C:x',
    'x\\y',
    '',
    '~',
    '\\x',
    '/x',
    '\\\\.\\pipe\\x',
    '\\\\.\\CON',
    '\\\\?\\C:\\x',
    '\\\\?\\UNC\\srv\\s',
    '//./PhysicalDrive0',
  ])('refuses %s', (path) => {
    expect(isFullyQualifiedPath(path, 'win32')).toBe(false);
  });
});

describe('startsWithTildeSeparator', () => {
  it('accepts ~/ everywhere and ~\\ on win32 only', () => {
    for (const platform of [...POSIX_PLATFORMS, 'win32'] as const) {
      expect(startsWithTildeSeparator('~/x', platform)).toBe(true);
      expect(startsWithTildeSeparator('~user/x', platform)).toBe(false);
      expect(startsWithTildeSeparator('~x', platform)).toBe(false);
      expect(startsWithTildeSeparator('~', platform)).toBe(false);
      expect(startsWithTildeSeparator('x/~/y', platform)).toBe(false);
    }
    expect(startsWithTildeSeparator('~\\x', 'win32')).toBe(true);
    expect(startsWithTildeSeparator('~\\x', 'linux')).toBe(false);
    expect(startsWithTildeSeparator('~\\x', 'darwin')).toBe(false);
  });
});

describe('fromGitPath', () => {
  it('leaves every POSIX value untouched, even a Windows spelling', () => {
    for (const platform of POSIX_PLATFORMS) {
      for (const path of ['/a/b', 'C:/x', 'C:\\x', '/a//b/']) {
        expect(fromGitPath(path, platform)).toBe(path);
      }
    }
  });
  it("turns Git for Windows' C:/a/b into C:\\a\\b on win32", () => {
    expect(fromGitPath('C:/a/b', 'win32')).toBe('C:\\a\\b');
    expect(fromGitPath('C:\\a\\b', 'win32')).toBe('C:\\a\\b');
    expect(fromGitPath('//srv/share/x', 'win32')).toBe('\\\\srv\\share\\x');
  });
});

describe('isDotGitSegment', () => {
  it('matches only .git on POSIX', () => {
    for (const platform of POSIX_PLATFORMS) {
      expect(isDotGitSegment('.git', platform)).toBe(true);
      for (const name of ['.GIT', '.Git', '.git.', '.git ', '.git::$INDEX_ALLOCATION', '.gitignore', '']) {
        expect(isDotGitSegment(name, platform), name).toBe(false);
      }
    }
  });
  it.each(['.git', '.GIT', '.Git', '.git.', '.git ', '.git. .', '.git::$INDEX_ALLOCATION', '.git:s'])(
    'matches %j on win32',
    (name) => {
      expect(isDotGitSegment(name, 'win32')).toBe(true);
    },
  );
  it.each(['.gitignore', '.github', 'git', 'x.git', '', '.gi', '.git2'])('does not match %j on win32', (name) => {
    expect(isDotGitSegment(name, 'win32')).toBe(false);
  });
});

describe('isDrivePath', () => {
  it.each(['C:\\x', 'c:/x', 'Z:\\'])('is a drive path on every OS: %s', (value) => {
    expect(isDrivePath(value)).toBe(true);
  });
  it.each(['C:x', 'C:', '/C:/x', '\\\\srv\\s', '1:\\x', 'file:///C:/x', ''])('is not a drive path: %j', (value) => {
    expect(isDrivePath(value)).toBe(false);
  });
});

/** File URLs Git for Windows turns into `//host/share` (#963): each one would reach an SMB server. */
const NETWORK_FILE_URLS = [
  'file://srv/s/x',
  'FILE://srv/x',
  'file:////host/share',
  'file:///\\host\\share',
  'file://///h/s',
  'FILE:////srv/x',
  'file:///\\\\host\\share',
  'file:////?/C:/x',
  'file:C:/x',
  'file:///C:x',
  // No drive letter: not provably local, so refused with the rest.
  'file:///srv/x',
];

describe('isWindowsNetworkSource', () => {
  it.each(['//srv/s/x', '\\\\srv\\s\\x', '//./pipe/x', ...NETWORK_FILE_URLS])(
    'is a network source on win32: %s',
    (value) => {
      expect(isWindowsNetworkSource(value, 'win32')).toBe(true);
    },
  );
  it.each([
    'file:///C:/x',
    'file://C:/x',
    'FILE:///c:\\x',
    'C:\\x',
    '~\\x',
    'owner/name',
    'https://example.com/r.git',
  ])(
    'is not a network source on win32: %s',
    (value) => {
      expect(isWindowsNetworkSource(value, 'win32')).toBe(false);
    },
  );
  it('is never a network source on POSIX', () => {
    for (const platform of POSIX_PLATFORMS) {
      for (const value of ['//srv/s/x', '\\\\srv\\s\\x', ...NETWORK_FILE_URLS]) {
        expect(isWindowsNetworkSource(value, platform), value).toBe(false);
      }
    }
  });
});
