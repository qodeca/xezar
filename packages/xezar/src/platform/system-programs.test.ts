import { describe, expect, it } from 'vitest';
import { regExePath } from './long-paths.ts';
import { POWERSHELL_IN_SYSTEM32, powershellPath, system32Program } from './system-programs.ts';

describe('system32Program', () => {
  it('joins SystemRoot, System32 and the name with Windows separators', () => {
    expect(system32Program('cmd.exe', { SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(system32Program(POWERSHELL_IN_SYSTEM32, { SYSTEMROOT: 'D:/Win' })).toBe(
      'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
  });

  it.each([
    ['unset', {}],
    ['empty', { SystemRoot: '' }],
    ['relative', { SystemRoot: 'Windows' }],
    ['drive-relative', { SystemRoot: 'C:Windows' }],
    ['rooted without a drive', { SystemRoot: '\\Windows' }],
    ['UNC', { SystemRoot: '\\\\server\\share\\Windows' }],
    ['device', { SystemRoot: '\\\\?\\C:\\Windows' }],
  ])('answers null when SystemRoot is %s', (_label, env: NodeJS.ProcessEnv) => {
    expect(system32Program('cmd.exe', env)).toBeNull();
  });

  it('is what regExePath answers for reg.exe', () => {
    for (const env of [{ SystemRoot: 'C:\\Windows' }, { SystemRoot: 'Windows' }, {}] as NodeJS.ProcessEnv[]) {
      expect(regExePath(env)).toBe(system32Program('reg.exe', env));
    }
  });
});

describe('powershellPath (ARCH-6, SEC-963-05)', () => {
  const SYSTEM_PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

  it('is System32 PowerShell whenever SystemRoot is a drive path, searching or not', () => {
    const exists = (): boolean => true;
    expect(powershellPath({ SystemRoot: 'C:\\Windows', PATH: 'D:\\tools' }, {}, { exists })).toBe(SYSTEM_PS);
    expect(powershellPath({ SystemRoot: 'C:\\Windows', PATH: 'D:\\tools' }, { searchPath: true }, { exists })).toBe(SYSTEM_PS);
  });

  it('never searches PATH unless asked: the kill and the command-line reader degrade', () => {
    expect(powershellPath({ PATH: 'D:\\tools' }, {}, { exists: () => true })).toBeNull();
  });

  it('searches only fully-qualified PATH entries when asked, in PATH order', () => {
    const present = new Set(['bin\\powershell.exe', '.\\powershell.exe', 'D:\\tools\\powershell.exe', 'E:\\ps\\powershell.exe']);
    const exists = (path: string): boolean => present.has(path);
    expect(powershellPath({ Path: '.;bin;C:rel;D:\\tools;E:\\ps' }, { searchPath: true }, { exists })).toBe('D:\\tools\\powershell.exe');
    expect(powershellPath({ PATH: '.;bin' }, { searchPath: true }, { exists })).toBeNull();
    expect(powershellPath({}, { searchPath: true }, { exists })).toBeNull();
  });
});
