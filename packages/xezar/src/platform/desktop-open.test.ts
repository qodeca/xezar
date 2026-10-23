import { describe, expect, it } from 'vitest';
import { browserLaunch, fileManagerLabel, hostDesktop, npmLauncherName, pathOpenerLaunch } from './desktop-open.ts';

const toWindows = (posixPath: string): string => `W:${posixPath}`;

describe('hostDesktop (#963)', () => {
  it('names macOS and Windows from the platform alone, and never asks about WSL there', () => {
    const asked: string[] = [];
    const wsl = () => {
      asked.push('wsl');
      return true;
    };
    expect(hostDesktop(wsl, 'darwin')).toBe('macos');
    expect(hostDesktop(wsl, 'win32')).toBe('windows');
    expect(asked).toEqual([]);
  });

  it('tells WSL from plain Linux only by the check it is given, defaulting to plain Linux', () => {
    expect(hostDesktop(() => true, 'linux')).toBe('wsl');
    expect(hostDesktop(() => false, 'linux')).toBe('linux');
    expect(hostDesktop(undefined, 'linux')).toBe('linux');
  });
});

describe('pathOpenerLaunch – one opener for a folder and a file', () => {
  it('GUARD: macOS and Linux keep `open` and `xdg-open` with the path unchanged', () => {
    expect(pathOpenerLaunch('/r/a b', 'macos', toWindows)).toEqual({ bin: 'open', args: ['/r/a b'] });
    expect(pathOpenerLaunch('/r/a b', 'linux', toWindows)).toEqual({ bin: 'xdg-open', args: ['/r/a b'] });
  });

  it('Windows hands the path to Explorer, never to cmd.exe', () => {
    expect(pathOpenerLaunch('C:\\r\\a&calc&.png', 'windows', toWindows)).toEqual({ bin: 'explorer', args: ['C:\\r\\a&calc&.png'] });
  });

  it('WSL goes to the Windows Explorer with the Windows spelling of the path', () => {
    expect(pathOpenerLaunch('/home/p/a.png', 'wsl', toWindows)).toEqual({ bin: 'explorer.exe', args: ['W:/home/p/a.png'] });
  });
});

describe('fileManagerLabel', () => {
  it('names the file manager each desktop has', () => {
    expect(fileManagerLabel('macos')).toBe('Finder');
    expect(fileManagerLabel('windows')).toBe('Explorer');
    expect(fileManagerLabel('wsl')).toBe('Explorer');
    expect(fileManagerLabel('linux')).toBe('Files');
  });
});

describe('browserLaunch', () => {
  it('Windows starts the URL through cmd.exe `start`, for launchCmd to check', () => {
    expect(browserLaunch('http://127.0.0.1:1/', 'win32')).toEqual({ via: 'cmd', args: ['/c', 'start', '', 'http://127.0.0.1:1/'] });
  });

  it('GUARD: macOS uses `open`, every other platform `xdg-open`', () => {
    expect(browserLaunch('http://x/', 'darwin')).toEqual({ via: 'detached', bin: 'open', args: ['http://x/'] });
    expect(browserLaunch('http://x/', 'linux')).toEqual({ via: 'detached', bin: 'xdg-open', args: ['http://x/'] });
    expect(browserLaunch('http://x/', 'freebsd')).toEqual({ via: 'detached', bin: 'xdg-open', args: ['http://x/'] });
  });
});

describe('npmLauncherName', () => {
  it('is npm’s own `.cmd` on Windows and the bare name elsewhere', () => {
    expect(npmLauncherName('npx', 'win32')).toBe('npx.cmd');
    expect(npmLauncherName('npm', 'win32')).toBe('npm.cmd');
    expect(npmLauncherName('npx', 'linux')).toBe('npx');
    expect(npmLauncherName('npx', 'darwin')).toBe('npx');
  });
});
