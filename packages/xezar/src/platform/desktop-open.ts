/**
 * Which desktop xezar hands a folder, a file or a link to, and the program that opens it there
 * (#963). Pure – nothing here starts a program; the callers start what these answer through
 * `process-launch.ts`.
 *
 * Four desktops, not three platforms: WSL reads `linux`, but it has no Linux desktop of its own –
 * the user's file manager, default apps and terminals are the Windows ones, reached through WSL
 * interop with a Windows spelling of the path. Detecting WSL needs `/proc/version` and the
 * environment (`server/wsl.ts`), so the caller passes that check in; it runs only on Linux.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */

export type HostDesktop = 'macos' | 'windows' | 'wsl' | 'linux';

/** The desktop of this host. `isWsl` is asked only on Linux, and defaults to "no". */
export function hostDesktop(isWsl: () => boolean = () => false, platform: NodeJS.Platform = process.platform): HostDesktop {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return isWsl() ? 'wsl' : 'linux';
}

/**
 * The program that opens `path` with the desktop's registered handler – a folder in the file
 * manager, a file in its default app. Never a shell and never cmd.exe: `path` may be worktree
 * content, and `explorer` hands it on without re-reading its command line (BatBadBut,
 * CVE-2024-27980). Under WSL the Windows Explorer gets the Windows spelling of the path.
 */
export function pathOpenerLaunch(
  path: string,
  desktop: HostDesktop,
  toWindowsPath: (posixPath: string) => string,
): { bin: string; args: string[] } {
  if (desktop === 'macos') return { bin: 'open', args: [path] };
  if (desktop === 'windows') return { bin: 'explorer', args: [path] };
  if (desktop === 'wsl') return { bin: 'explorer.exe', args: [toWindowsPath(path)] };
  return { bin: 'xdg-open', args: [path] };
}

/** What the file-manager target is called on this desktop. */
export function fileManagerLabel(desktop: HostDesktop): 'Finder' | 'Explorer' | 'Files' {
  if (desktop === 'macos') return 'Finder';
  return desktop === 'windows' || desktop === 'wsl' ? 'Explorer' : 'Files';
}

/**
 * How a URL reaches the browser: on Windows `cmd /c start "" <url>`, which must go through
 * `launchCmd` (it refuses a URL cmd.exe would reinterpret); elsewhere `open` / `xdg-open`.
 */
export function browserLaunch(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { via: 'cmd'; args: string[] } | { via: 'detached'; bin: string; args: string[] } {
  if (platform === 'win32') return { via: 'cmd', args: ['/c', 'start', '', url] };
  return { via: 'detached', bin: platform === 'darwin' ? 'open' : 'xdg-open', args: [url] };
}

/** The file name of npm's own launcher: `npx.cmd` / `npm.cmd` on Windows, the bare name elsewhere. */
export function npmLauncherName(name: 'npm' | 'npx', platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${name}.cmd` : name;
}
