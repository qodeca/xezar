/**
 * How a path is SPELLED on each platform (#963). Pure string rules: nothing here touches the disk.
 *
 * Every platform-dependent function takes `platform` LAST and defaults it to the host, so the Windows
 * answer is testable from Linux and the POSIX answer from Windows. Each POSIX branch is the exact expression
 * the call site used before this module existed, so Linux and macOS answer byte-for-byte as they did.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { posix, win32 } from 'node:path';

/** `\\.\…`, `\\?\…`, `//./…`: device and namespace paths. Never a folder a person types. */
const WIN32_DEVICE_PREFIX = /^[\\/]{2}[?.](?:[\\/]|$)/;
/** `C:\…` or `C:/…`: a drive letter followed by a separator. */
const WIN32_DRIVE_ROOTED = /^[A-Za-z]:[\\/]/;
/** `\\server\share…` or `//server/share…`: a UNC path naming both a server and a share. The server
 *  name may not start with `.` or `?`, so `\\..\x` (a parent step, not a server) is never a share;
 *  the share may not be exactly `.` or `..` (`\\srv\..`, `\\srv\.\x`), which are steps, not names –
 *  `\\srv\.hidden` stays a share. The device forms are refused before this runs. */
const WIN32_UNC_SHARE = /^[\\/]{2}[^\\/?.][^\\/]*[\\/](?!\.\.?(?:[\\/]|$))[^\\/]+/;
/** Any spelling of the `file:` scheme. */
const FILE_SCHEME = /^file:/i;
/** What a local file URL puts before its drive: `file://` and an optional third `/`. */
const FILE_URL_LOCAL_PREFIX = /^file:\/\/\/?/i;

/**
 * `C:\…` or `C:/…`: a drive letter and a separator. The same answer on every OS – a pure spelling
 * check for a value that must name a local Windows drive wherever it is read.
 */
export function isDrivePath(path: string): boolean {
  return WIN32_DRIVE_ROOTED.test(path);
}

/**
 * The READ rule, for stored values and Git output. POSIX: `path.posix.isAbsolute` (≡ a leading
 * `/`). win32: `path.win32.isAbsolute` – `C:\x`, `C:/x`, `\\srv\share\x`, `//srv/share/x`, `\x`,
 * `/x` and device forms; never `C:x`, `x\y`, `''` or `~`.
 */
export function isAbsolutePath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? win32.isAbsolute(path) : posix.isAbsolute(path);
}

/**
 * The rule for a folder a person TYPED. POSIX: the same as `isAbsolutePath`. win32 is stricter: a
 * drive path (`C:\x`, `C:/x`) or a UNC share that names a server AND a share (`\\srv\share`), and
 * never a rooted path without a drive (`\x`, `/x`, which follows whatever drive the process happens
 * to be on), a server without a share (`\\srv`), a `.` or `..` step in the server or share place
 * (`\\..\x`, `\\srv\..`) or a device/namespace path (`\\.\pipe\x`, `\\?\C:\x`, `//./PhysicalDrive0`),
 * which must never reach `stat`, git or a clone.
 */
export function isFullyQualifiedPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return isAbsolutePath(path, platform);
  return (
    win32.isAbsolute(path) &&
    !WIN32_DEVICE_PREFIX.test(path) &&
    (WIN32_DRIVE_ROOTED.test(path) || WIN32_UNC_SHARE.test(path))
  );
}

/** `~/…` everywhere; `~\…` on win32 only. Never `~user` or `~x`. */
export function startsWithTildeSeparator(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return path.startsWith('~/') || (platform === 'win32' && path.startsWith('~\\'));
}

/** Git for Windows prints `C:/x/y`; the rest of Windows spells it `C:\x\y`. POSIX: unchanged. */
export function fromGitPath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? win32.normalize(path) : path;
}

/** The other direction, for a relative path handed TO Git (a pathspec, an `info/exclude` line):
 *  Git reads `\` as an escape there, so win32 spells it with `/`. POSIX: unchanged. */
export function toGitPath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.replaceAll('\\', '/') : path;
}

/**
 * Does this single path segment name the `.git` folder? POSIX: exactly `.git`. win32: Windows opens
 * `.GIT`, `.git.`, `.git ` and `.git::$INDEX_ALLOCATION` as the same folder, so drop an NTFS stream
 * suffix (from the first `:`), then trailing dots and spaces, and compare without case.
 */
export function isDotGitSegment(name: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return name === '.git';
  const colon = name.indexOf(':');
  const withoutStream = colon === -1 ? name : name.slice(0, colon);
  return withoutStream.replace(/[. ]+$/, '').toLowerCase() === '.git';
}

/**
 * A source that makes Windows open a network share: `//…`, `\\…` (UNC and device forms) or any
 * `file:` value that is not a local drive URL. Opening one sends the user's Windows credentials to
 * that server. The only file URLs allowed are `file://C:/…` and `file:///C:/…` (any letter case,
 * either separator): Git for Windows turns other spellings – `file://server/…`,
 * `file:////server/…`, `file:///\server\…`, `file://///server/…` – into `//server/…`.
 * POSIX: always false – `//x` is an ordinary local path there.
 */
export function isWindowsNetworkSource(value: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false;
  if (/^[\\/]{2}/.test(value)) return true;
  return FILE_SCHEME.test(value) && !isDrivePath(value.replace(FILE_URL_LOCAL_PREFIX, ''));
}
