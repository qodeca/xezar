/**
 * Finding a program on a search path, and reading the environment the way a child will (#963).
 *
 * Pure: the file system is reached only through the `exists` callback, so every Windows rule here
 * runs on every OS in tests.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { isFullyQualifiedPath } from './path-syntax.ts';

/** The extensions a program search may add or accept on Windows, in cmd.exe's default order.
 *  `.js`, `.vbs` and the rest of PATHEXT are left to the shell that registered them. */
const SEARCHABLE_EXTENSIONS: readonly string[] = ['.COM', '.EXE', '.BAT', '.CMD'];

export interface PathSearchOptions {
  /** `;` on Windows, `:` elsewhere. */
  delimiter: string;
  join: (dir: string, name: string) => string;
  exists: (path: string) => boolean;
  /** Skip every entry that is not fully qualified (see `isRelativeEntry`), so a search never
   *  looks in a folder that depends on the working folder. */
  skipRelative?: boolean;
  /** Whose rules apply. win32 also strips the double quotes Windows allows around an entry. */
  platform?: NodeJS.Platform;
}

export interface PathHit {
  /** The name that matched, as it was asked for (it may carry an added extension). */
  name: string;
  /** `join(entry, name)`. */
  path: string;
}

function unquote(entry: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? entry.replace(/^"|"$/g, '') : entry;
}

/**
 * An entry that depends on the working folder: anything that is not `isFullyQualifiedPath`, so
 * on Windows empty, `.`, `C:foo` and `\foo` (SEC-9).
 */
export function isRelativeEntry(entry: string, platform: NodeJS.Platform = process.platform): boolean {
  return !isFullyQualifiedPath(unquote(entry, platform), platform);
}

/** Does `searchPath` hold at least one entry that depends on the working folder? */
export function hasRelativeEntry(
  searchPath: string,
  o: Pick<PathSearchOptions, 'delimiter' | 'platform'>,
): boolean {
  const platform = o.platform ?? process.platform;
  return searchPath.split(o.delimiter).some((entry) => isRelativeEntry(entry, platform));
}

/**
 * The first `join(entry, name)` that `exists`, entry by entry and, within an entry, name by name
 * – the order a shell searches in. Empty entries are always skipped. Null when nothing matches.
 */
export function firstOnPath(names: readonly string[], searchPath: string, o: PathSearchOptions): PathHit | null {
  const platform = o.platform ?? process.platform;
  for (const raw of searchPath.split(o.delimiter)) {
    const dir = unquote(raw, platform);
    if (!dir) continue;
    if (o.skipRelative && isRelativeEntry(dir, platform)) continue;
    for (const name of names) {
      const path = o.join(dir, name);
      if (o.exists(path)) return { name, path };
    }
  }
  return null;
}

/**
 * The value a child started with `env` sees for `name`. POSIX: `env[name]`, exactly. win32:
 * names are case-insensitive, and when `env` holds several spellings (`{ ...process.env, PATH }`
 * next to an inherited `Path`) Node keeps the one that sorts first – it sorts the keys it
 * enumerates and drops later duplicates – so this does the same.
 */
export function envValue(
  env: NodeJS.ProcessEnv,
  name: string,
  deps: { platform?: NodeJS.Platform } = {},
): string | undefined {
  if ((deps.platform ?? process.platform) !== 'win32') return env[name];
  const wanted = name.toUpperCase();
  const spellings: string[] = [];
  // `for…in`, not Object.keys: Node enumerates inherited keys too.
  for (const key in env) {
    if (key.toUpperCase() === wanted) spellings.push(key);
  }
  const first = spellings.sort()[0];
  return first === undefined ? undefined : env[first];
}

/**
 * The extensions a Windows search tries, in PATHEXT order: PATHEXT ∩ {.COM, .EXE, .BAT, .CMD},
 * upper-cased. Without PATHEXT, cmd.exe's default order.
 */
export function windowsSearchExtensions(env: NodeJS.ProcessEnv): string[] {
  const pathext = envValue(env, 'PATHEXT', { platform: 'win32' });
  if (pathext === undefined) return [...SEARCHABLE_EXTENSIONS];
  const out: string[] = [];
  for (const raw of pathext.split(';')) {
    const ext = raw.trim().toUpperCase();
    if (SEARCHABLE_EXTENSIONS.includes(ext) && !out.includes(ext)) out.push(ext);
  }
  return out;
}

/** Is `ext` (any case, with its dot) one a Windows search may accept? */
export function isSearchableExtension(ext: string): boolean {
  return SEARCHABLE_EXTENSIONS.includes(ext.toUpperCase());
}
