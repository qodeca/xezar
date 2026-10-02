import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  envValue,
  firstOnPath,
  hasRelativeEntry,
  isRelativeEntry,
  isSearchableExtension,
  windowsSearchExtensions,
} from './path-search.ts';

const existing = (paths: readonly string[]) => (path: string): boolean => paths.includes(path);

describe('firstOnPath', () => {
  const windows = { delimiter: ';', join: win32.join, platform: 'win32' as const };

  it('searches entry by entry, and name by name within an entry', () => {
    const exists = existing(['C:\\b\\tool.EXE', 'C:\\b\\tool.CMD', 'C:\\c\\tool.COM']);
    expect(firstOnPath(['tool.COM', 'tool.EXE', 'tool.CMD'], 'C:\\a;C:\\b;C:\\c', { ...windows, exists })).toEqual({
      name: 'tool.EXE',
      path: 'C:\\b\\tool.EXE',
    });
  });

  it('strips the quotes Windows allows around an entry, and skips empty entries', () => {
    const exists = existing(['C:\\Program Files\\x\\tool.exe']);
    expect(firstOnPath(['tool.exe'], ';;"C:\\Program Files\\x";', { ...windows, exists })?.path).toBe(
      'C:\\Program Files\\x\\tool.exe',
    );
  });

  it('never looks in an entry that depends on the working folder when asked not to', () => {
    // win32.join('.', 'tool.exe') is 'tool.exe': the working folder itself.
    const exists = existing(['tool.exe', 'C:tool.exe', '\\bin\\tool.exe', 'bin\\tool.exe', 'C:\\ok\\tool.exe']);
    const searchPath = '.;C:;\\bin;bin;C:\\ok';
    expect(firstOnPath(['tool.exe'], searchPath, { ...windows, exists, skipRelative: true })?.path).toBe(
      'C:\\ok\\tool.exe',
    );
    expect(firstOnPath(['tool.exe'], searchPath, { ...windows, exists })?.path).toBe('tool.exe');
  });

  it('keeps quotes and uses the host rule on POSIX', () => {
    const exists = existing(['"/q"/tool', '/usr/bin/tool']);
    const options = { delimiter: ':', join: posix.join, exists, platform: 'linux' as const };
    expect(firstOnPath(['tool'], '"/q":/usr/bin', options)?.path).toBe('"/q"/tool');
    expect(firstOnPath(['tool'], 'rel:/usr/bin', { ...options, skipRelative: true })?.path).toBe('/usr/bin/tool');
  });

  it('answers null when nothing matches', () => {
    expect(firstOnPath(['tool.exe'], 'C:\\a', { ...windows, exists: () => false })).toBeNull();
    expect(firstOnPath(['tool.exe'], '', { ...windows, exists: () => true })).toBeNull();
  });
});

describe('relative entries (SEC-9)', () => {
  it.each(['', '.', '..\\bin', 'C:foo', '\\foo', '/foo', 'bin', '""'])('%j is relative on win32', (entry) => {
    expect(isRelativeEntry(entry, 'win32')).toBe(true);
  });

  it.each(['C:\\bin', 'C:/bin', '"C:\\Program Files\\x"', '\\\\server\\share\\bin'])('%j is not', (entry) => {
    expect(isRelativeEntry(entry, 'win32')).toBe(false);
  });

  it('finds one in a search path, including an empty entry', () => {
    const o = { delimiter: ';', platform: 'win32' as const };
    expect(hasRelativeEntry('C:\\a;C:\\b', o)).toBe(false);
    expect(hasRelativeEntry('C:\\a;;C:\\b', o)).toBe(true);
    expect(hasRelativeEntry('C:\\a;.', o)).toBe(true);
  });
});

describe('envValue', () => {
  it('reads the exact name on POSIX', () => {
    expect(envValue({ Path: '/x' }, 'PATH', { platform: 'linux' })).toBeUndefined();
    expect(envValue({ PATH: '/x' }, 'PATH', { platform: 'darwin' })).toBe('/x');
  });

  it('on win32 picks the spelling that sorts first, whatever the insertion order', () => {
    expect(envValue({ Path: 'second', PATH: 'first' }, 'PATH', { platform: 'win32' })).toBe('first');
    expect(envValue({ PATH: 'first', Path: 'second' }, 'path', { platform: 'win32' })).toBe('first');
    expect(envValue({ path: 'last', Path: 'middle' }, 'PATH', { platform: 'win32' })).toBe('middle');
    expect(envValue({ Other: 'x' }, 'PATH', { platform: 'win32' })).toBeUndefined();
  });

  it('on win32 sees inherited keys, as Node does', () => {
    const env = Object.create({ PATH: 'inherited' }) as NodeJS.ProcessEnv;
    env.Path = 'own';
    expect(envValue(env, 'PATH', { platform: 'win32' })).toBe('inherited');
  });
});

describe('windowsSearchExtensions', () => {
  it('keeps PATHEXT order, only the four searchable extensions, upper-cased and once each', () => {
    expect(windowsSearchExtensions({ PATHEXT: '.cmd;.JS;.Exe;.BAT;.VBS;.COM;.exe' })).toEqual([
      '.CMD',
      '.EXE',
      '.BAT',
      '.COM',
    ]);
  });

  it("falls back to cmd.exe's default order without PATHEXT, and reads any spelling", () => {
    expect(windowsSearchExtensions({})).toEqual(['.COM', '.EXE', '.BAT', '.CMD']);
    expect(windowsSearchExtensions({ PathExt: '.EXE' })).toEqual(['.EXE']);
  });

  it('knows which extensions are searchable', () => {
    expect(['.exe', '.CMD', '.Com', '.bat'].every(isSearchableExtension)).toBe(true);
    expect(['.js', '', '.ps1'].some(isSearchableExtension)).toBe(false);
  });
});
