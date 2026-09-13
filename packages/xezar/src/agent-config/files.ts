import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, stat, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { agentHomePaths } from '../paths.ts';
import { configFileRoot, findConfigFile, type ConfigFileDef } from './catalog.ts';
import { checkedConfigPath, ConfigPathRefusal, readConfigBytes } from './path-access.ts';
import { validateConfig } from './validate.ts';

/**
 * Read and write the coding agents' own config files, addressed by catalog id
 * (never by a client-supplied path, so traversal is impossible by
 * construction). Every function degrades — a missing file is "absent", an
 * unreadable one is an honest error — and none throw. Writes validate first,
 * refuse a stale overwrite via a content hash, refuse unsafe symlinks and write
 * atomically, and never touch a byte the user did not type.
 */

/** sha256 of the exact file bytes. mtime is coarse and lies across filesystems. */
function hashBytes(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface ReadResult {
  id: string;
  path: string;
  exists: boolean;
  content: string;
  /** sha256 of the bytes, or null when the file does not exist. */
  version: string | null;
}

export type WriteOutcome =
  | { ok: true; read: ReadResult }
  | { ok: false; status: 400 | 409 | 500; error: string };

function resolvePath(def: ConfigFileDef, repoRoot: string, env: NodeJS.ProcessEnv): string {
  return def.resolve(repoRoot, agentHomePaths(env));
}

/** Read a config file by id. Unknown id → null; absent file → exists:false; unreadable → thrown-free error string via `error`. */
export async function readConfigFile(
  id: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReadResult | { error: string; status?: 409 } | null> {
  const def = findConfigFile(id);
  if (!def) return null;
  const path = resolvePath(def, repoRoot, env);
  try {
    const target = await checkedConfigPath(path, configFileRoot(def, repoRoot, agentHomePaths(env)));
    const content = await readConfigBytes(target);
    return { id, path, exists: true, content, version: hashBytes(content) };
  } catch (err) {
    if (err instanceof ConfigPathRefusal) return { error: err.message, status: err.status };
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { id, path, exists: false, content: '', version: null };
    return { error: e.message };
  }
}

/**
 * Write a config file by id. Validates the content against the file's format,
 * refuses when `version` does not match what is on disk (stale / lost-update),
 * creates the parent dir on demand, and refuses unsafe symlinks before reading
 * the stale-write token or writing any bytes. `version: null` means "I expect no file to
 * exist yet" — the create path.
 */
export async function writeConfigFile(
  id: string,
  content: string,
  version: string | null,
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WriteOutcome | null> {
  const def = findConfigFile(id);
  if (!def) return null;

  const check = validateConfig(content, def.format);
  if (!check.ok) return { ok: false, status: 400, error: `Invalid ${def.format}: ${check.error}` };

  const path = resolvePath(def, repoRoot, env);

  const root = configFileRoot(def, repoRoot, agentHomePaths(env));
  let target: string;
  // Stale-write guard: the version the caller read must still match disk.
  let current: string | null = null;
  try {
    target = await checkedConfigPath(path, root);
    current = await readConfigBytes(target);
  } catch (err) {
    if (err instanceof ConfigPathRefusal) return { ok: false, status: err.status, error: err.message };
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { ok: false, status: 500, error: (err as Error).message };
    }
  }
  // Footgun guard: emptying a populated file passes format validation (empty is
  // valid TOML/markdown, and JSON just errors) but silently wipes real config —
  // unrecoverable for the gitignored/home files that aren't in git. Refuse it;
  // deleting a config file is a deliberate act, not a stray select-all-delete.
  if (content.trim() === '' && current !== null && current.trim() !== '') {
    return {
      ok: false,
      status: 400,
      error: 'refusing to overwrite a non-empty config file with empty content — delete the file manually if you mean to remove it',
    };
  }

  const currentVersion = current === null ? null : hashBytes(current);
  if (currentVersion !== version) {
    return {
      ok: false,
      status: 409,
      error:
        currentVersion === null
          ? 'the file no longer exists on disk — reload before saving'
          : 'the file changed on disk since you opened it — reload before saving',
    };
  }

  let tmp: string | undefined;
  try {
    target = await checkedConfigPath(path, root);
    await mkdir(dirname(target), { recursive: true });
    // Re-check after parent creation and before rename. Never resolve a leaf symlink's target.
    target = await checkedConfigPath(path, root);
    tmp = `${target}.xez-tmp-${process.pid}-${randomUUID()}`;
    await writeFile(tmp, content, { encoding: 'utf8', flag: 'wx' });
    if (await checkedConfigPath(path, root) !== target) throw new ConfigPathRefusal('outside-root');
    await rename(tmp, target);
    const written = await readConfigBytes(target);
    return { ok: true, read: { id, path, exists: true, content: written, version: hashBytes(written) } };
  } catch (err) {
    if (err instanceof ConfigPathRefusal) return { ok: false, status: err.status, error: err.message };
    return { ok: false, status: 500, error: (err as Error).message };
  } finally {
    if (tmp) await unlink(tmp).catch(() => {});
  }
}

/** Whether a path currently exists (used by the listing to report `exists`/`size`). */
export async function statConfigPath(path: string): Promise<{ exists: boolean; size: number }> {
  try {
    const s = await stat(path);
    return { exists: true, size: s.size };
  } catch {
    return { exists: false, size: 0 };
  }
}

export { resolvePath, hashBytes };
