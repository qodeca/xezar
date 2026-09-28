/**
 * Platform seams for tests (#963). Every export returns the pre-#963 POSIX value on Linux and
 * macOS, so adopting a helper never changes what a POSIX run does; only the Windows branch is new.
 * Pinned by `test/unit/test-platform-helpers.test.ts`.
 */
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const onWindows = process.platform === 'win32';

/** Home for a local socket. POSIX keeps literal `/tmp`: a Unix socket path is capped near 104 bytes
 *  and the per-run TMPDIR can be deeper. Windows has no xezar MCP socket yet (#963): tmpdir(). */
export function shortTmpRoot(): string {
  return onWindows ? tmpdir() : '/tmp';
}

/** Directory link. POSIX: symlink (type ignored). Windows: junction – no privilege needed; a
 *  relative target resolves against the link's parent directory. */
export function linkDir(target: string, path: string): void {
  symlinkSync(target, path, onWindows ? 'junction' : 'dir');
}

function probeFileSymlink(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'xez-symlink-probe-'));
  try {
    const target = join(dir, 'target.txt');
    writeFileSync(target, ''); // link to an EXISTING file…
    symlinkSync(target, join(dir, 'link.txt'), 'file'); // …with an explicit 'file' type
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false; // no privilege: the only "no"
    throw error; // anything else is a real failure
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** True on POSIX without probing. Windows file symlinks need Developer Mode or elevation. */
export const FILE_SYMLINKS: boolean = !onWindows || probeFileSymlink();

/** POSIX: `npm` from PATH, unchanged. Windows: npm's own CLI through node (the
 *  `scripts/check-pack.mjs` pattern) – `npm.cmd` cannot be spawned without a shell, and a shell
 *  fallback would re-parse every argument, so a missing npm CLI is an error instead. */
export function npmCommand(args: readonly string[]): { file: string; args: string[] } {
  if (!onWindows) return { file: 'npm', args: [...args] };
  const fromEnv = process.env.npm_execpath;
  // Only npm's own CLI counts: under npx, pnpm or yarn the variable names something else.
  if (fromEnv && basename(fromEnv) === 'npm-cli.js') return { file: process.execPath, args: [fromEnv, ...args] };
  const bundled = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(bundled)) return { file: process.execPath, args: [bundled, ...args] };
  throw new Error(
    `npmCommand: npm's CLI was not found – npm_execpath does not name npm-cli.js (${fromEnv ?? 'unset'}) ` +
      `and ${bundled} does not exist`,
  );
}
