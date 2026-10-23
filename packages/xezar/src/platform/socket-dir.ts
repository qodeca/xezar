/**
 * A temp folder short enough to hold a Unix socket.
 *
 * A Unix socket path is limited to `sun_path`: 104 bytes on macOS and 108 on Linux, each including
 * the closing NUL, and `listen` fails with EINVAL past it. `os.tmpdir()` is short on a default
 * install (`/var/folders/…/T/`, `/tmp`), but a `TMPDIR` set deeper – a per-run temp folder inside a
 * project, or a checkout under another checkout – pushes a socket below it past the limit. Then,
 * and only then, the socket goes to `/tmp`, which every POSIX system has. Windows uses named pipes,
 * which have no such limit, so it always keeps `os.tmpdir()`.
 */
import { tmpdir } from 'node:os';

/** The longest socket path that fits everywhere: macOS's 104 bytes, minus the NUL. */
export const UNIX_SOCKET_PATH_MAX_BYTES = 103;

/** The POSIX folder a socket falls back to when the temp folder is too deep. */
const POSIX_SHORT_TEMP = '/tmp';

/**
 * `base` (the temp folder) when a socket path of `belowBytes` more bytes still fits under it, and
 * the short POSIX temp folder otherwise. `belowBytes` counts everything the caller adds below the
 * folder, separators included.
 */
export function socketTempRoot(belowBytes: number, base: string = tmpdir(), platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return base;
  return Buffer.byteLength(base) + belowBytes <= UNIX_SOCKET_PATH_MAX_BYTES ? base : POSIX_SHORT_TEMP;
}
