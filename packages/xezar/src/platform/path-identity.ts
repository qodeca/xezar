/**
 * Is this the SAME folder? (#963, owner decision Q3.)
 *
 * IDENTITY ONLY: these helpers decide "same project", "same folder", "same home". They may WIDEN a
 * refusal (treat one more spelling as the protected folder), and must never GRANT access – a
 * containment guard that lets a path through because it "looks inside" would be fooled by every
 * spelling these rules do not unify.
 *
 * POSIX: case-sensitive, byte-exact – every function is the exact expression its call site used
 * before (#963 keeps Linux and macOS identical). win32: case- and separator-insensitive, because
 * `C:\Repo`, `c:\repo` and Git's `C:/Repo` open the same folder. Limits on win32: lower-casing is
 * not the NTFS upcase table, a folder with per-directory case sensitivity (WSL) is merged with its
 * case twin, and 8.3 short names or `\\?\` prefixes are NOT unified – canonicalise with the native
 * `realpath` first when that matters.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { win32 } from 'node:path';

/** The win32 comparison key: normalized separators, no trailing separator unless the path IS a
 *  root (`C:\`, `\\srv\share\`), lower-cased. Private so no caller stores or displays it. */
function win32IdentityKey(path: string): string {
  const normalized = win32.normalize(path);
  const isRoot = win32.parse(normalized).root === normalized;
  const trimmed = !isRoot && /[\\/]$/.test(normalized) ? normalized.slice(0, -1) : normalized;
  return trimmed.toLowerCase();
}

/** POSIX: `a === b`. win32: the two spellings name the same folder (case/separators ignored). */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return a === b;
  return win32IdentityKey(a) === win32IdentityKey(b);
}

/**
 * Is `child` strictly below `parent`? POSIX: `child.startsWith(parent + '/')`. win32: on identity
 * keys; a root parent (`C:\`) works; `C:\foo` never contains `C:\foobar`; equal paths answer false.
 */
export function isInsideByIdentity(
  parent: string,
  child: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return child.startsWith(parent + '/');
  const parentKey = win32IdentityKey(parent);
  const childKey = win32IdentityKey(child);
  if (childKey === parentKey) return false;
  const prefix = parentKey.endsWith('\\') ? parentKey : `${parentKey}\\`;
  return childKey.startsWith(prefix);
}

/**
 * Does `path` contain the consecutive folder names `segments`? POSIX:
 * `` `${path}/`.includes(`/${segments.join('/')}/`) ``. win32: the same on the identity key with `\`.
 */
export function containsPathSegments(
  path: string,
  segments: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return `${path}/`.includes(`/${segments.join('/')}/`);
  const needle = `\\${segments.join('\\')}\\`.toLowerCase();
  return `${win32IdentityKey(path)}\\`.includes(needle);
}

/**
 * The fallback after an exact key missed: the value of the first entry whose key names the same
 * folder as `path`. POSIX: always `undefined` (the exact lookup already said everything).
 */
export function lookupSamePath<T>(
  entries: Iterable<readonly [string, T]>,
  path: string,
  platform: NodeJS.Platform = process.platform,
): T | undefined {
  if (platform !== 'win32') return undefined;
  const key = win32IdentityKey(path);
  for (const [candidate, value] of entries) {
    if (win32IdentityKey(candidate) === key) return value;
  }
  return undefined;
}

/**
 * Is `realTarget` the repository's `.git` folder, or inside it, in any spelling Windows opens as that
 * folder? Both arguments are native-`realpath` answers, so an 8.3 alias (`GIT~1`) has already become
 * the real long name. win32 only: it widens the Files tab's `.git` refusal. POSIX: always false –
 * there the exact-spelling checks that run before this one already answer.
 */
export function isInsideDotGit(
  realTarget: string,
  realRoot: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return false;
  const realGit = win32.join(realRoot, '.git');
  return samePath(realTarget, realGit, 'win32') || isInsideByIdentity(realGit, realTarget, 'win32');
}
