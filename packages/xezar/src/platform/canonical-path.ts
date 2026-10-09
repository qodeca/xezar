/**
 * The spelling a containment check compares (#963). Answers "is this folder inside that one" from
 * one exact spelling per folder, never by comparing case-insensitively: that is how
 * `path-identity.ts` may only ever WIDEN a refusal.
 *
 * Linux and macOS: `fs.realpath` / `fs.realpathSync`, and `resolve` for the lexical half – the
 * expressions the call sites used before this module existed.
 *
 * Windows: `realpath.native`. The JavaScript realpath keeps the spelling it was given for every
 * part that is not a link, so `c:\root` and `C:\Root`, an 8.3 short name (`C:\PROGRA~1`) and a
 * `subst` drive each name one folder in a spelling no prefix test matches. The native call answers
 * the folder's own name. A native failure other than "not there" falls back to the JavaScript
 * realpath. The lexical half resolves the nearest existing ancestor the same way and keeps the
 * missing tail as written, so a refusal reads the same whether the path exists or not.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { existsSync, realpath as realpathCallback, realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const realpathNative = promisify(realpathCallback.native);

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/** The real path, or null when it cannot be read. */
export async function containmentRealpath(path: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (platform === 'win32') {
    try {
      return await realpathNative(path);
    } catch (error) {
      if (code(error) === 'ENOENT') return null;
    }
  }
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** `containmentRealpath`, synchronously. */
export function containmentRealpathSync(path: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') {
    try {
      return realpathSync.native(path);
    } catch (error) {
      if (code(error) === 'ENOENT') return null;
    }
  }
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * The lexical spelling of `path` for a containment check that must not ask whether it exists.
 * POSIX: `resolve(path)`. Windows: the nearest existing ancestor's real path, with the rest of
 * `path` as written – the same answer for a folder that is there and one that is not.
 */
export async function containmentSpelling(path: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  const absolute = resolve(path);
  if (platform !== 'win32') return absolute;
  const rest: string[] = [];
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return absolute;
    rest.unshift(basename(existing));
    existing = parent;
  }
  const real = await containmentRealpath(existing, platform);
  return real === null ? absolute : join(real, ...rest);
}
