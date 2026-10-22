/**
 * Platform seams for tests (#963). Every export returns the pre-#963 POSIX value on Linux and
 * macOS, so adopting a helper never changes what a POSIX run does; only the Windows branch is new.
 * `withPlatform` is the one tool of another kind: it makes a test run a Windows branch on every OS.
 * Pinned by `test/unit/test-platform-helpers.test.ts`.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, type RmOptions } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const onWindows = process.platform === 'win32';

const RM_MAX_RETRIES = 10;
const RM_RETRY_DELAY_MS = 100;

/** `rmSync` options for removing a test's scratch directory. POSIX: the pre-#963
 *  `{ recursive, force }`. Windows adds a retry: right after files were written, Windows
 *  can refuse the delete with `EPERM` while a delete-pending handle or a file scanner lets go, even
 *  when no process holds the directory. EBUSY, EMFILE, ENFILE, ENOTEMPTY and EPERM are retried
 *  with a linear backoff of `retryDelay` ms per try (fs.rmSync docs) – about 5.5 s at most, then
 *  the error surfaces as before. Node's own rmSync does not honour this on Windows (Node 24 skips
 *  "access denied" and does not pause), so `scripts/test-local-state.mjs` supplies the retry. */
export const TEST_DIR_RM_OPTIONS: Readonly<RmOptions> = onWindows
  ? { recursive: true, force: true, maxRetries: RM_MAX_RETRIES, retryDelay: RM_RETRY_DELAY_MS }
  : { recursive: true, force: true };

/** `rmSync` options for a scratch HOME that xezar's own background work may still be writing into
 *  when the file ends (#985): the team-skills catalog clones its bare repo into
 *  `<home>/.cache/xez/skills/…`, unref'd, and the removal can list the folder just before git adds
 *  a file to it – `ENOTEMPTY` on every OS. Node's retry, on every OS, lets the removal finish once
 *  the clone gives up on its deleted target (the same retry `TEST_DIR_RM_OPTIONS` uses on Windows). */
export const BACKGROUND_WRITER_RM_OPTIONS: Readonly<RmOptions> = {
  recursive: true,
  force: true,
  maxRetries: RM_MAX_RETRIES,
  retryDelay: RM_RETRY_DELAY_MS,
};

/** Home for a local socket. POSIX keeps literal `/tmp`: a Unix socket path is capped near 104 bytes
 *  and the per-run TMPDIR can be deeper. Windows serves MCP on a named pipe, with no path limit: tmpdir(). */
/**
 * The environment for a Git Bash a test starts with ordinary command-line quoting (#963). With
 * `MSYS=noglob` – which the kit's gate sets for its own shells, so every test under a gate inherits
 * it – the MSYS runtime no longer takes ordinary quotes apart, and `bash -c '…'` silently runs
 * nothing and exits 0. Windows: a copy without the `MSYS` variable. Linux and macOS: `env` itself.
 */
export function plainMsysEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!onWindows) return env;
  const copy: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() !== 'MSYS') copy[key] = value;
  return copy;
}

export function shortTmpRoot(): string {
  return onWindows ? tmpdir() : '/tmp';
}

/** A local socket a test server listens on: `<dir>/<name>` on POSIX, a unique named pipe on Windows,
 *  where `net` cannot listen on a file path. */
export function localSocketPath(dir: string, name: string): string {
  return onWindows ? `\\\\.\\pipe\\xezar-test-${name}-${randomBytes(8).toString('hex')}` : join(dir, name);
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

/**
 * Run `fn` while `process.platform` reports `platform`, and put the real value back afterwards,
 * also when `fn` throws. For code that reads the platform at CALL time – every `src/platform/`
 * helper defaults its `platform` argument to `process.platform` – so a Linux or macOS run exercises
 * the Windows branch of a call site too. Only the reported name changes: `node:path`, the file
 * system and child processes stay the host's, so a test run this way must not depend on a Windows
 * file system (store the other spelling; never expect it to exist on disk).
 */
export async function withPlatform<T>(platform: NodeJS.Platform, fn: () => T | Promise<T>): Promise<T> {
  const saved = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...saved, value: platform });
  try {
    return await fn();
  } finally {
    if (saved) Object.defineProperty(process, 'platform', saved);
  }
}
