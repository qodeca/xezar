/**
 * A short path to a deep directory, for programs that put a Unix socket in it (#1065).
 *
 * A Unix socket path is limited to `sun_path`: 108 bytes on Linux, including the closing NUL.
 * Chrome puts its singleton socket at `$TMPDIR/com.google.Chrome.XXXXXX/SingletonSocket` – 41
 * bytes past `$TMPDIR` – and aborts with "Socket path too long" when the whole does not fit, so a
 * per-run `TMPDIR` deep inside a project (`<project>/.local/xezar/tmp/<runId>`) stopped every
 * browser a task started. A link with a short name in the host temp folder fixes the path the
 * program sees and leaves the bytes where they were.
 *
 * Windows has no such socket path. macOS also has a 104-byte limit, but Chrome there takes its
 * socket folder from the per-user Darwin temp folder rather than `TMPDIR` (checked, #1065), so
 * both keep the path they were given.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** The longest directory a socket-making program is handed as is. 108 bytes, minus the NUL,
 *  minus Chrome's 41, leaves 66; the rest is headroom for a program with a longer name. */
export const SOCKET_SAFE_DIR_BYTES = 60;

/** True when `dir` is too long for a Unix socket below it on this platform. */
export function needsShortDirLink(dir: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32' || platform === 'darwin') return false;
  return Buffer.byteLength(dir) > SOCKET_SAFE_DIR_BYTES;
}

/** Where the short link for `target` lives: one fixed name per target, so a later turn of the same
 *  run finds the same link and removal needs nothing but the target. */
export function shortDirLinkPath(target: string, root: string = tmpdir()): string {
  return join(root, `xez-${createHash('sha256').update(target).digest('hex').slice(0, 12)}`);
}

/** A link target as written, comparable with the path it was made from: Windows junctions read
 *  back with a `\\?\` prefix and may carry a trailing separator. */
function linkTargetKey(path: string): string {
  return resolve(path.replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, '');
}

/** True when `link` is a link this user owns and that leads to `target` – also once `target` is
 *  gone, so a dangling link can still be removed. The host temp folder is shared, so a name
 *  someone else created is never trusted, whatever it points at. */
function isOwnLink(link: string, target: string): boolean {
  try {
    const stat = lstatSync(link);
    if (!stat.isSymbolicLink()) return false;
    if (process.getuid && stat.uid !== process.getuid()) return false;
    return linkTargetKey(readlinkSync(link)) === linkTargetKey(target);
  } catch {
    return false;
  }
}

/**
 * The short path to `target`, creating the link when it is missing. Returns `target` itself when
 * no link can be made or the name is taken by anything but our own link – the long path still
 * works for everything but a socket, so a missing link degrades to the old behaviour, never to a
 * failed run. POSIX: a symlink. Windows (tests only): a junction, which needs no privilege.
 */
export function ensureShortDirLink(target: string, root: string = tmpdir()): string {
  const link = shortDirLinkPath(target, root);
  if (Buffer.byteLength(link) >= Buffer.byteLength(target)) return target;
  try {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return link;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return target;
  }
  return isOwnLink(link, target) ? link : target;
}

/** Remove the short link to `target`, only when it is our own link to it. Never throws. */
export function removeShortDirLink(target: string, root: string = tmpdir()): void {
  const link = shortDirLinkPath(target, root);
  if (!isOwnLink(link, target)) return;
  try {
    // Removes the link, never what it points at. A Windows junction only goes with `rmdir`.
    if (process.platform === 'win32') rmdirSync(link);
    else unlinkSync(link);
  } catch {
    // best-effort: a stale link in the host temp folder points at a folder that is gone.
  }
}
