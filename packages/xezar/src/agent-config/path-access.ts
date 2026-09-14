import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Internal typed refusal; routes expose only the existing `{ error }` body. */
export class ConfigPathRefusal extends Error {
  readonly status = 409;
  constructor(readonly reason: 'symlink' | 'outside-root') {
    super(reason === 'symlink'
      ? 'refusing a symlink at an agent config file'
      : 'refusing an agent config directory symlink outside its home or repository');
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Canonicalize existing ancestors, retaining absent suffixes for new files. */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new ConfigPathRefusal('symlink');
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // A dangling directory link is not an absent directory we can safely create.
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new ConfigPathRefusal('symlink');
    } catch (statErr) {
      if ((statErr as NodeJS.ErrnoException).code !== 'ENOENT') throw statErr;
    }
    const parent = dirname(path);
    if (parent === path) throw err;
    return join(await canonicalPath(parent), basename(path));
  }
}

/** Enforce catalog.ts's policy before any content is opened, including missing files. */
export async function checkedConfigPath(path: string, root: string): Promise<string> {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  if (absolutePath === absoluteRoot || !inside(absoluteRoot, absolutePath)) throw new ConfigPathRefusal('outside-root');
  const canonicalRoot = await canonicalPath(absoluteRoot);
  let parent = dirname(absolutePath);
  // Check every ancestor below the root: an escape followed by a link back in is still an escape.
  while (parent !== absoluteRoot) {
    if (!inside(canonicalRoot, await canonicalPath(parent))) throw new ConfigPathRefusal('outside-root');
    parent = dirname(parent);
  }
  try {
    if ((await lstat(absolutePath)).isSymbolicLink()) throw new ConfigPathRefusal('symlink');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new ConfigPathRefusal('symlink');
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return join(await canonicalPath(dirname(absolutePath)), basename(absolutePath));
}

/** O_NOFOLLOW also refuses a leaf replaced by a link after the path check. */
export async function readConfigBuffer(path: string): Promise<Buffer> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return await file.readFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new ConfigPathRefusal('symlink');
    throw err;
  } finally {
    await file?.close();
  }
}

export async function readConfigBytes(path: string): Promise<string> {
  return (await readConfigBuffer(path)).toString('utf8');
}
