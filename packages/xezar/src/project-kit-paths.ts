import { join, resolve } from 'node:path';
import { xezarHomeDir } from './paths.ts';

export const PROJECT_KIT_DIR = '.xezar';

/**
 * One whole directory supplies project configuration, workflows and skills, for
 * both reads and writes: `<repo>/.xezar`. Discovery is read-only and creates
 * nothing; an absent kit simply leaves every default in place.
 *
 * This helper never resolves the separate per-user `~/.xezar` directory.
 */
export function projectKitDir(repoRoot: string): string {
  const canonical = join(repoRoot, PROJECT_KIT_DIR);
  // A home-directory launch is not a project registration. In particular, init
  // and PUT /config there must never turn the user's workspace file into a kit,
  // so the kit moves into that launch's own local state instead.
  if ([xezarHomeDir(), xezarHomeDir({})].some(home => resolve(home) === resolve(canonical))) {
    return join(repoRoot, '.local/xezar/kit');
  }
  return canonical;
}
