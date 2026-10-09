import { describe, expect, it } from 'vitest';
import { pathWithLoginShell } from './login-shell-path.ts';

describe('pathWithLoginShell (#963)', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    it(`puts the login PATH first and drops duplicates on ${platform}`, () => {
      const run = () => 'motd line\n/home/u/.local/bin:/usr/bin\n';
      expect(pathWithLoginShell('/usr/bin:/bin', { run }, platform)).toBe('/home/u/.local/bin:/usr/bin:/bin');
    });

    it(`leaves PATH alone when the shell prints nothing on ${platform}`, () => {
      expect(pathWithLoginShell('/usr/bin', { run: () => '\n' }, platform)).toBeUndefined();
    });
  }

  it('never runs a shell on win32 and leaves PATH alone', () => {
    let ran = false;
    const run = () => {
      ran = true;
      return '/usr/local/sbin:/usr/bin';
    };
    expect(pathWithLoginShell('C:\\Windows;C:\\Tools', { run }, 'win32')).toBeUndefined();
    expect(ran).toBe(false);
  });
});
